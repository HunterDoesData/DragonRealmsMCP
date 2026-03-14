import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
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
  metadata: {
    fields: string[];
  };
  retrieval: {
    strategy: string;
    denseTopK: number;
    sparseTopK: number;
    rerankTopN: number;
    finalTopN: number;
    maxChunksPerPage: number;
  };
  freshness: {
    incrementalSyncHours: number;
    weeklyIntegrityPass: boolean;
    reembedOnlyChangedRevisions: boolean;
  };
  answerPolicy: {
    requireCitations: boolean;
    citationFields: string[];
    lowConfidenceBehavior: string;
  };
};

type CliOptions = {
  configPath: string;
  outputDir: string;
  pageLimit?: number;
};

type Section = {
  headingPath: string;
  text: string;
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
  const slice = words.slice(Math.max(0, words.length - maxWords));
  return slice.join(" ");
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    configPath: "examples/elanthipedia-hotset.config.json",
    outputDir: "data/rag"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" && argv[i + 1]) {
      options.configPath = argv[i + 1];
      i += 1;
    } else if (arg === "--out" && argv[i + 1]) {
      options.outputDir = argv[i + 1];
      i += 1;
    } else if (arg === "--limit" && argv[i + 1]) {
      options.pageLimit = Number(argv[i + 1]);
      i += 1;
    }
  }

  return options;
}

function namespaceNameToId(name: string): number {
  const normalized = name.trim().toLowerCase();
  if (normalized === "main") {
    return 0;
  }
  return 0;
}

function toCanonicalUrl(baseUrl: string, title: string): string {
  const normalizedBase = baseUrl.replace(/\/$/, "");
  return `${normalizedBase}/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
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

function parseCategoryName(raw: string): string {
  return raw.replace(/^Category:/i, "").trim();
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
        headers: {
          "User-Agent": userAgent
        }
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

async function fetchCategoryMembers(
  config: HotsetConfig,
  limiter: RateLimiter,
  category: string,
  namespaceId: number
): Promise<string[]> {
  const titles: string[] = [];
  let nextContinue: string | undefined;

  do {
    const url = new URL(API_PATH, config.source.baseUrl);
    url.searchParams.set("action", "query");
    url.searchParams.set("format", "json");
    url.searchParams.set("formatversion", "2");
    url.searchParams.set("list", "categorymembers");
    url.searchParams.set("cmtitle", `Category:${category}`);
    url.searchParams.set("cmnamespace", String(namespaceId));
    url.searchParams.set("cmtype", "page");
    url.searchParams.set("cmlimit", "500");
    if (nextContinue) {
      url.searchParams.set("cmcontinue", nextContinue);
    }

    const data = await fetchJson<{
      query?: { categorymembers?: Array<{ title: string }> };
      continue?: { cmcontinue?: string };
    }>(url, config.source.userAgent, config.source.retry, limiter);

    const batch = data.query?.categorymembers ?? [];
    for (const item of batch) {
      if (item.title) {
        titles.push(item.title);
      }
    }

    nextContinue = data.continue?.cmcontinue;
  } while (nextContinue);

  return titles;
}

async function fetchAllPagesByPrefix(
  config: HotsetConfig,
  limiter: RateLimiter,
  prefix: string,
  namespaceId: number
): Promise<string[]> {
  const titles: string[] = [];
  let nextContinue: string | undefined;

  do {
    const url = new URL(API_PATH, config.source.baseUrl);
    url.searchParams.set("action", "query");
    url.searchParams.set("format", "json");
    url.searchParams.set("formatversion", "2");
    url.searchParams.set("list", "allpages");
    url.searchParams.set("apnamespace", String(namespaceId));
    url.searchParams.set("apprefix", prefix);
    url.searchParams.set("aplimit", "500");
    if (nextContinue) {
      url.searchParams.set("apcontinue", nextContinue);
    }

    const data = await fetchJson<{
      query?: { allpages?: Array<{ title: string }> };
      continue?: { apcontinue?: string };
    }>(url, config.source.userAgent, config.source.retry, limiter);

    const batch = data.query?.allpages ?? [];
    for (const item of batch) {
      if (item.title) {
        titles.push(item.title);
      }
    }

    nextContinue = data.continue?.apcontinue;
  } while (nextContinue);

  return titles;
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
    parse?: {
      title: string;
      pageid: number;
      text: string;
    };
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
    .filter((entry) => entry.length > 0);

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

function chunkSection(
  section: Section,
  page: Omit<PageRecord, "extracted_sections">,
  config: HotsetConfig
): ChunkRecord[] {
  const chunks: ChunkRecord[] = [];
  const paragraphs = section.text
    .split(/\n{2,}/)
    .map((entry) => normalizeWhitespace(entry))
    .filter((entry) => entry.length > 0);

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

    const chunkId = sha1(`${page.doc_id}|${section.headingPath}|${chunkIndex}|${normalized}`);
    chunks.push({
      doc_id: page.doc_id,
      chunk_id: chunkId,
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

function titleIsExcluded(title: string, excludeRegex: RegExp[]): boolean {
  return excludeRegex.some((pattern) => pattern.test(title));
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = (await import(path.resolve(options.configPath), {
    with: { type: "json" }
  })) as { default: HotsetConfig };
  const resolvedConfig = config.default;

  const limiter = new RateLimiter(resolvedConfig.source.rateLimitRps);
  const namespaceId = namespaceNameToId(resolvedConfig.scope.namespaces[0] ?? "Main");
  const excludeRegex = resolvedConfig.scope.excludeTitleRegex.map((pattern) => new RegExp(pattern, "i"));

  const candidateTitles = new Set<string>();

  for (const category of resolvedConfig.scope.includeCategories) {
    const titles = await fetchCategoryMembers(resolvedConfig, limiter, category, namespaceId);
    for (const title of titles) {
      candidateTitles.add(title);
    }
  }

  for (const prefix of resolvedConfig.scope.includeTitlePrefixes) {
    const titles = await fetchAllPagesByPrefix(resolvedConfig, limiter, prefix, namespaceId);
    for (const title of titles) {
      candidateTitles.add(title);
    }
  }

  const filteredTitles = Array.from(candidateTitles)
    .filter((title) => !titleIsExcluded(title, excludeRegex))
    .sort((a, b) => a.localeCompare(b));

  const limitedTitles =
    options.pageLimit && Number.isFinite(options.pageLimit)
      ? filteredTitles.slice(0, Math.max(1, Math.floor(options.pageLimit)))
      : filteredTitles;

  await mkdir(options.outputDir, { recursive: true });
  const pagesOutput = path.join(options.outputDir, "elanthipedia-pages.jsonl");
  const chunksOutput = path.join(options.outputDir, "elanthipedia-chunks.jsonl");
  const manifestOutput = path.join(options.outputDir, "elanthipedia-manifest.json");
  await writeFile(pagesOutput, "", "utf8");
  await writeFile(chunksOutput, "", "utf8");

  let processed = 0;
  let skipped = 0;
  let chunkCount = 0;

  for (const title of limitedTitles) {
    try {
      const pageData = await fetchPageData(resolvedConfig, limiter, title);
      const canonicalUrl = toCanonicalUrl(resolvedConfig.source.baseUrl, pageData.title);
      if (resolvedConfig.scope.excludeUrlContains.some((entry) => canonicalUrl.includes(entry))) {
        skipped += 1;
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
        namespace: resolvedConfig.scope.namespaces[0] ?? "Main",
        categories: pageData.categories,
        redirect_target: null
      };

      const sections = extractSections(pageData.html, resolvedConfig);
      const pageRecord: PageRecord = {
        ...pageBase,
        extracted_sections: sections.length
      };
      await appendFile(pagesOutput, `${JSON.stringify(pageRecord)}\n`, "utf8");

      for (const section of sections) {
        const chunks = chunkSection(section, pageBase, resolvedConfig);
        for (const chunk of chunks) {
          await appendFile(chunksOutput, `${JSON.stringify(chunk)}\n`, "utf8");
          chunkCount += 1;
        }
      }

      processed += 1;
      if (processed % 25 === 0) {
        console.log(`Processed ${processed}/${limitedTitles.length} pages...`);
      }
    } catch (error) {
      skipped += 1;
      console.warn(`Skipped '${title}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const manifest = {
    configName: resolvedConfig.name,
    generatedAt: new Date().toISOString(),
    sourceBaseUrl: resolvedConfig.source.baseUrl,
    candidateTitles: filteredTitles.length,
    processedPages: processed,
    skippedPages: skipped,
    chunksGenerated: chunkCount,
    output: {
      pages: pagesOutput,
      chunks: chunksOutput
    }
  };
  await writeFile(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`Done. Pages=${processed}, Chunks=${chunkCount}, Skipped=${skipped}`);
  console.log(`Manifest: ${manifestOutput}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
