import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Element } from "domhandler";

type RetryConfig = {
  maxAttempts: number;
  backoffMs: number[];
};

type HotsetConfig = {
  name: string;
  source: {
    baseUrl: string;
    mode: string;
    userAgent: string;
    rateLimitRps: number;
    maxConcurrency: number;
    retry: RetryConfig;
  };
  scope: {
    namespaces: string[];
    includeCategories: string[];
    includeTitlePrefixes: string[];
    excludeTitleRegex: string[];
    excludeUrlContains: string[];
  };
  extraction: {
    stripSelectors: string[];
    includeSectionHeadings: string[];
    tableHandling: string;
  };
  chunking: {
    targetTokens: number;
    maxTokens: number;
    minTokens: number;
    overlapTokens: number;
    commandSectionTargetTokens: number;
    preserveTopLevelHeadings: boolean;
  };
};

type DeltaState = {
  configName: string;
  lastSyncAt: string;
};

type PageRecord = {
  doc_id: string;
  page_id: number;
  title: string;
  canonical_url: string;
  revision_id: number;
  updated_at: string;
  namespace: string;
  categories: string[];
  redirect_target: string | null;
  extracted_sections: number;
};

type ChunkRecord = {
  doc_id: string;
  chunk_id: string;
  title: string;
  heading_path: string;
  url: string;
  revision_id: number;
  updated_at: string;
  category_tags: string[];
  topic_tags: string[];
  guild_tags: string[];
  skill_tags: string[];
  token_count: number;
  text: string;
};

type Section = {
  headingPath: string;
  text: string;
};

type CliOptions = {
  configPath: string;
  dataDir: string;
  sinceIso?: string;
};

const API_PATH = "/api.php";

class RateLimiter {
  private readonly minIntervalMs: number;
  private nextAllowedAt: number;

  constructor(requestsPerSecond: number) {
    this.minIntervalMs = Math.max(1, Math.floor(1000 / Math.max(0.1, requestsPerSecond)));
    this.nextAllowedAt = Date.now();
  }

  async waitTurn(): Promise<void> {
    const now = Date.now();
    if (now < this.nextAllowedAt) {
      await sleep(this.nextAllowedAt - now);
    }
    this.nextAllowedAt = Date.now() + this.minIntervalMs;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function estimateTokens(value: string): number {
  if (!value.trim()) {
    return 0;
  }
  const words = value.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words * 1.3));
}

function tailWords(value: string, tokenBudget: number): string {
  if (tokenBudget <= 0 || !value.trim()) {
    return "";
  }

  const words = value.trim().split(/\s+/);
  const maxWords = Math.max(1, Math.floor(tokenBudget / 1.3));
  return words.slice(Math.max(0, words.length - maxWords)).join(" ");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    configPath: "examples/elanthipedia-hotset.config.json",
    dataDir: "data/rag"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" && argv[i + 1]) {
      options.configPath = argv[i + 1];
      i += 1;
    } else if (arg === "--dataDir" && argv[i + 1]) {
      options.dataDir = argv[i + 1];
      i += 1;
    } else if (arg === "--since" && argv[i + 1]) {
      options.sinceIso = argv[i + 1];
      i += 1;
    }
  }

  return options;
}

function parseCategoryName(raw: string): string {
  return raw.replace(/^Category:/i, "").trim();
}

function sectionMatchesFilter(headingPath: string, includeHeadings: string[]): boolean {
  if (includeHeadings.length === 0) {
    return true;
  }
  if (!headingPath) {
    return true;
  }
  const lower = headingPath.toLowerCase();
  return includeHeadings.some((heading) => lower.includes(heading.toLowerCase()));
}

function toCanonicalUrl(baseUrl: string, title: string): string {
  const normalizedBase = baseUrl.replace(/\/$/, "");
  return `${normalizedBase}/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
}

function deriveTopicTags(title: string, categories: string[]): string[] {
  const tags = new Set<string>();
  for (const category of categories) {
    const normalized = category.toLowerCase();
    if (["skills", "spells", "combat", "magic", "commands", "crafting", "foraging", "first aid", "alchemy"].includes(normalized)) {
      tags.add(category);
    }
  }

  const lowerTitle = title.toLowerCase();
  if (lowerTitle.startsWith("skill:")) {
    tags.add("Skills");
  }
  if (lowerTitle.startsWith("spell:")) {
    tags.add("Spells");
  }
  if (lowerTitle.startsWith("command:")) {
    tags.add("Commands");
  }

  return Array.from(tags);
}

function deriveGuildTags(title: string, categories: string[]): string[] {
  const knownGuilds = [
    "Barbarian",
    "Bard",
    "Cleric",
    "Empath",
    "Moon Mage",
    "Necromancer",
    "Paladin",
    "Ranger",
    "Thief",
    "Trader",
    "Warrior Mage"
  ];

  const values = `${title} ${categories.join(" ")}`.toLowerCase();
  return knownGuilds.filter((guild) => values.includes(guild.toLowerCase()));
}

function deriveSkillTags(title: string, categories: string[]): string[] {
  const tags = new Set<string>();
  const lowerTitle = title.toLowerCase();
  if (lowerTitle.startsWith("skill:")) {
    tags.add(title.replace(/^skill:/i, "").trim());
  }
  for (const category of categories) {
    if (category.toLowerCase().endsWith("skills")) {
      tags.add(category.replace(/skills$/i, "").trim());
    }
  }
  return Array.from(tags).filter((entry) => entry.length > 0);
}

async function fetchJson<T>(
  url: URL,
  userAgent: string,
  retry: RetryConfig,
  limiter: RateLimiter
): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    await limiter.waitTurn();
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": userAgent }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      const backoff = retry.backoffMs[Math.min(attempt - 1, retry.backoffMs.length - 1)] ?? 1000;
      if (attempt < retry.maxAttempts) {
        await sleep(backoff);
      }
    }
  }

  throw new Error(`Request failed after ${retry.maxAttempts} attempts: ${String(lastError)}`);
}

async function fetchRecentChangedTitles(
  config: HotsetConfig,
  limiter: RateLimiter,
  sinceIso: string
): Promise<string[]> {
  const titles = new Set<string>();
  let rcContinue: string | undefined;

  do {
    const url = new URL(API_PATH, config.source.baseUrl);
    url.searchParams.set("action", "query");
    url.searchParams.set("format", "json");
    url.searchParams.set("formatversion", "2");
    url.searchParams.set("list", "recentchanges");
    url.searchParams.set("rcprop", "title|timestamp|ids");
    url.searchParams.set("rctype", "edit|new");
    url.searchParams.set("rcnamespace", "0");
    url.searchParams.set("rclimit", "500");
    url.searchParams.set("rcdir", "newer");
    url.searchParams.set("rcstart", sinceIso);
    if (rcContinue) {
      url.searchParams.set("rccontinue", rcContinue);
    }

    const payload = await fetchJson<{
      query?: { recentchanges?: Array<{ title?: string }> };
      continue?: { rccontinue?: string };
    }>(url, config.source.userAgent, config.source.retry, limiter);

    for (const entry of payload.query?.recentchanges ?? []) {
      if (entry.title) {
        titles.add(entry.title);
      }
    }

    rcContinue = payload.continue?.rccontinue;
  } while (rcContinue);

  return Array.from(titles).sort((a, b) => a.localeCompare(b));
}

async function fetchPageData(
  config: HotsetConfig,
  limiter: RateLimiter,
  title: string
): Promise<{
  title: string;
  pageId: number;
  revisionId: number;
  updatedAt: string;
  categories: string[];
  html: string;
}> {
  const parseUrl = new URL(API_PATH, config.source.baseUrl);
  parseUrl.searchParams.set("action", "parse");
  parseUrl.searchParams.set("format", "json");
  parseUrl.searchParams.set("formatversion", "2");
  parseUrl.searchParams.set("page", title);
  parseUrl.searchParams.set("prop", "text");

  const parseData = await fetchJson<{
    parse?: { title: string; pageid: number; text: string };
    error?: { info?: string };
  }>(parseUrl, config.source.userAgent, config.source.retry, limiter);

  if (parseData.error || !parseData.parse?.text || !parseData.parse.title) {
    throw new Error(parseData.error?.info ?? `Failed to parse page: ${title}`);
  }

  const metaUrl = new URL(API_PATH, config.source.baseUrl);
  metaUrl.searchParams.set("action", "query");
  metaUrl.searchParams.set("format", "json");
  metaUrl.searchParams.set("formatversion", "2");
  metaUrl.searchParams.set("redirects", "1");
  metaUrl.searchParams.set("prop", "revisions|categories");
  metaUrl.searchParams.set("rvprop", "ids|timestamp");
  metaUrl.searchParams.set("cllimit", "max");
  metaUrl.searchParams.set("titles", parseData.parse.title);

  const metaData = await fetchJson<{
    query?: {
      pages?: Array<{
        pageid?: number;
        title?: string;
        revisions?: Array<{ revid?: number; timestamp?: string }>;
        categories?: Array<{ title?: string }>;
      }>;
    };
  }>(metaUrl, config.source.userAgent, config.source.retry, limiter);

  const page = metaData.query?.pages?.[0];
  const revision = page?.revisions?.[0];
  const categories = (page?.categories ?? [])
    .map((entry) => (entry.title ? parseCategoryName(entry.title) : ""))
    .filter((value) => value.length > 0);

  return {
    title: page?.title ?? parseData.parse.title,
    pageId: page?.pageid ?? parseData.parse.pageid,
    revisionId: revision?.revid ?? 0,
    updatedAt: revision?.timestamp ?? new Date().toISOString(),
    categories,
    html: parseData.parse.text
  };
}

function extractSections(html: string, config: HotsetConfig): Section[] {
  const $ = cheerio.load(html);
  for (const selector of config.extraction.stripSelectors) {
    $(selector).remove();
  }

  const root = $(".mw-parser-output").first();
  const container = root.length ? root : $.root();

  const sections: Array<{ headingPath: string; lines: string[] }> = [{ headingPath: "", lines: [] }];
  const headingStack: string[] = [];
  const headingRegex = /^h([2-6])$/i;

  const pushLine = (line: string): void => {
    const text = normalizeWhitespace(line);
    if (!text) {
      return;
    }
    sections[sections.length - 1].lines.push(text);
  };

  container.children().each((_index: number, element: Element) => {
    const tag = element.tagName?.toLowerCase() ?? "";
    const headingMatch = headingRegex.exec(tag);
    if (headingMatch) {
      const level = Number(headingMatch[1]);
      const headingText = normalizeWhitespace($(element).text());
      if (!headingText) {
        return;
      }

      const stackIndex = level - 2;
      headingStack[stackIndex] = headingText;
      headingStack.splice(stackIndex + 1);
      const headingPath = headingStack.join(" > ");

      if (sectionMatchesFilter(headingPath, config.extraction.includeSectionHeadings)) {
        sections.push({ headingPath, lines: [] });
      }
      return;
    }

    if (["p", "ul", "ol", "dl", "pre", "table", "blockquote"].includes(tag)) {
      const text = normalizeWhitespace($(element).text());
      if (text) {
        pushLine(text);
      }
    }
  });

  return sections
    .map((section) => ({
      headingPath: section.headingPath,
      text: section.lines.join("\n\n").trim()
    }))
    .filter((section) => section.text.length > 0);
}

function pageInScope(title: string, categories: string[], config: HotsetConfig, excludeRegex: RegExp[]): boolean {
  if (excludeRegex.some((pattern) => pattern.test(title))) {
    return false;
  }

  if (config.scope.includeTitlePrefixes.some((prefix) => title.toLowerCase().startsWith(prefix.toLowerCase()))) {
    return true;
  }

  const normalizedCategories = new Set(categories.map((category) => category.toLowerCase()));
  return config.scope.includeCategories.some((category) => normalizedCategories.has(category.toLowerCase()));
}

function chunkSection(
  section: Section,
  page: Omit<PageRecord, "extracted_sections">,
  config: HotsetConfig
): ChunkRecord[] {
  const chunks: ChunkRecord[] = [];
  const paragraphs = section.text
    .split(/\n{2,}/)
    .map((value) => normalizeWhitespace(value))
    .filter((value) => value.length > 0);

  if (paragraphs.length === 0) {
    return chunks;
  }

  const lowerHeading = section.headingPath.toLowerCase();
  const preferredTarget =
    lowerHeading.includes("syntax") || lowerHeading.includes("command")
      ? config.chunking.commandSectionTargetTokens
      : config.chunking.targetTokens;

  let buffer = "";
  let chunkIndex = 0;

  const flush = (): void => {
    const normalized = normalizeWhitespace(buffer);
    if (!normalized) {
      buffer = "";
      return;
    }

    const tokenCount = estimateTokens(normalized);
    if (tokenCount < config.chunking.minTokens && chunks.length > 0) {
      const previous = chunks[chunks.length - 1];
      previous.text = `${previous.text}\n\n${normalized}`;
      previous.token_count = estimateTokens(previous.text);
      buffer = "";
      return;
    }

    chunks.push({
      doc_id: page.doc_id,
      chunk_id: sha1(`${page.doc_id}|${section.headingPath}|${chunkIndex}|${normalized}`),
      title: page.title,
      heading_path: section.headingPath,
      url: page.canonical_url,
      revision_id: page.revision_id,
      updated_at: page.updated_at,
      category_tags: page.categories,
      topic_tags: deriveTopicTags(page.title, page.categories),
      guild_tags: deriveGuildTags(page.title, page.categories),
      skill_tags: deriveSkillTags(page.title, page.categories),
      token_count: tokenCount,
      text: normalized
    });
    chunkIndex += 1;
    buffer = "";
  };

  for (const paragraph of paragraphs) {
    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    const candidateTokens = estimateTokens(candidate);
    if (candidateTokens <= preferredTarget) {
      buffer = candidate;
      continue;
    }

    if (buffer) {
      const overlap = tailWords(buffer, config.chunking.overlapTokens);
      flush();
      buffer = overlap ? `${overlap}\n\n${paragraph}` : paragraph;
      if (estimateTokens(buffer) > config.chunking.maxTokens) {
        flush();
      }
      continue;
    }

    if (estimateTokens(paragraph) <= config.chunking.maxTokens) {
      buffer = paragraph;
      continue;
    }

    const words = paragraph.split(/\s+/);
    const maxWords = Math.max(20, Math.floor(config.chunking.maxTokens / 1.3));
    const overlapWords = Math.max(5, Math.floor(config.chunking.overlapTokens / 1.3));
    let start = 0;
    while (start < words.length) {
      const end = Math.min(words.length, start + maxWords);
      buffer = words.slice(start, end).join(" ");
      flush();
      if (end >= words.length) {
        break;
      }
      start = Math.max(end - overlapWords, start + 1);
    }
  }

  flush();
  return chunks;
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw
      .split(/\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

async function writeJsonl<T>(filePath: string, values: T[]): Promise<void> {
  const lines = values.map((value) => JSON.stringify(value));
  await writeFile(filePath, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");
}

async function readState(filePath: string): Promise<DeltaState | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as DeltaState;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const configModule = (await import(path.resolve(options.configPath), {
    with: { type: "json" }
  })) as { default: HotsetConfig };
  const config = configModule.default;

  const dataDir = path.resolve(options.dataDir);
  const deltaDir = path.join(dataDir, "delta");
  await mkdir(dataDir, { recursive: true });
  await mkdir(deltaDir, { recursive: true });

  const statePath = path.join(dataDir, "elanthipedia-state.json");
  const pagesPath = path.join(dataDir, "elanthipedia-pages.jsonl");
  const chunksPath = path.join(dataDir, "elanthipedia-chunks.jsonl");
  const manifestPath = path.join(dataDir, "elanthipedia-manifest.json");
  const deltaPagesPath = path.join(deltaDir, "elanthipedia-pages.delta.jsonl");
  const deltaChunksPath = path.join(deltaDir, "elanthipedia-chunks.delta.jsonl");

  const priorState = await readState(statePath);
  const fallbackSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const sinceIso = options.sinceIso ?? priorState?.lastSyncAt ?? fallbackSince;
  const nowIso = new Date().toISOString();

  const limiter = new RateLimiter(config.source.rateLimitRps);
  const changedTitles = await fetchRecentChangedTitles(config, limiter, sinceIso);
  if (changedTitles.length === 0) {
    await writeJsonl(deltaPagesPath, []);
    await writeJsonl(deltaChunksPath, []);
    await writeFile(
      statePath,
      JSON.stringify({ configName: config.name, lastSyncAt: nowIso } satisfies DeltaState, null, 2) + "\n",
      "utf8"
    );
    console.log("No changed titles detected since checkpoint.");
    return;
  }

  const excludeRegex = config.scope.excludeTitleRegex.map((pattern) => new RegExp(pattern, "i"));
  const deltaPages: PageRecord[] = [];
  const deltaChunks: ChunkRecord[] = [];
  const touchedTitles = new Set<string>();
  let skippedOutOfScope = 0;
  let skippedErrors = 0;

  for (const title of changedTitles) {
    try {
      const pageData = await fetchPageData(config, limiter, title);
      touchedTitles.add(pageData.title);

      if (!pageInScope(pageData.title, pageData.categories, config, excludeRegex)) {
        skippedOutOfScope += 1;
        continue;
      }

      const canonicalUrl = toCanonicalUrl(config.source.baseUrl, pageData.title);
      if (config.scope.excludeUrlContains.some((value) => canonicalUrl.includes(value))) {
        skippedOutOfScope += 1;
        continue;
      }

      const docId = sha1(`${canonicalUrl}|${pageData.revisionId}`);
      const pageBase: Omit<PageRecord, "extracted_sections"> = {
        doc_id: docId,
        page_id: pageData.pageId,
        title: pageData.title,
        canonical_url: canonicalUrl,
        revision_id: pageData.revisionId,
        updated_at: pageData.updatedAt,
        namespace: config.scope.namespaces[0] ?? "Main",
        categories: pageData.categories,
        redirect_target: null
      };

      const sections = extractSections(pageData.html, config);
      deltaPages.push({
        ...pageBase,
        extracted_sections: sections.length
      });
      for (const section of sections) {
        deltaChunks.push(...chunkSection(section, pageBase, config));
      }
    } catch {
      touchedTitles.add(title);
      skippedErrors += 1;
    }
  }

  const existingPages = await readJsonl<PageRecord>(pagesPath);
  const existingChunks = await readJsonl<ChunkRecord>(chunksPath);

  const deltaTitleSet = new Set(deltaPages.map((page) => page.title));
  const removeTitleSet = new Set<string>(Array.from(touchedTitles));

  const mergedPages = existingPages
    .filter((page) => !removeTitleSet.has(page.title))
    .concat(deltaPages)
    .sort((a, b) => a.title.localeCompare(b.title));

  const mergedChunks = existingChunks
    .filter((chunk) => !removeTitleSet.has(chunk.title))
    .concat(deltaChunks)
    .sort((a, b) => a.chunk_id.localeCompare(b.chunk_id));

  await writeJsonl(pagesPath, mergedPages);
  await writeJsonl(chunksPath, mergedChunks);
  await writeJsonl(deltaPagesPath, deltaPages);
  await writeJsonl(deltaChunksPath, deltaChunks);

  const manifest = {
    configName: config.name,
    generatedAt: nowIso,
    sourceBaseUrl: config.source.baseUrl,
    mode: "delta",
    sinceIso,
    changedTitlesDetected: changedTitles.length,
    touchedTitles: touchedTitles.size,
    deltaPagesWritten: deltaPages.length,
    deltaChunksWritten: deltaChunks.length,
    skippedOutOfScope,
    skippedErrors,
    mergedTotals: {
      pages: mergedPages.length,
      chunks: mergedChunks.length
    },
    output: {
      pages: pagesPath,
      chunks: chunksPath,
      deltaPages: deltaPagesPath,
      deltaChunks: deltaChunksPath
    },
    replacedTitles: Array.from(removeTitleSet).sort((a, b) => a.localeCompare(b)),
    includedTitles: Array.from(deltaTitleSet).sort((a, b) => a.localeCompare(b))
  };

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await writeFile(
    statePath,
    JSON.stringify({ configName: config.name, lastSyncAt: nowIso } satisfies DeltaState, null, 2) + "\n",
    "utf8"
  );

  console.log(`Delta ingest complete. Changed=${changedTitles.length}, DeltaPages=${deltaPages.length}, DeltaChunks=${deltaChunks.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
