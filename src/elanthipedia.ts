import * as cheerio from "cheerio";

const API_BASE = "https://elanthipedia.play.net/api.php";

export type ElanthipediaSearchResult = {
  title: string;
  description: string;
  url: string;
};

export type ElanthipediaPage = {
  title: string;
  url: string;
  text: string;
};

export type GuildSkill = {
  skill: string;
  guild: string;
  skillset: string;
  training: string;
  bonus: string;
  url: string;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function toTitleCase(value: string): string {
  return value
    .trim()
    .replace(/_/g, " ")
    .split(/\s+/)
    .map((word) => (word.length > 0 ? `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}` : ""))
    .join(" ")
    .trim();
}

async function parsePageHtml(titleOrUrl: string): Promise<{ title: string; html: string }> {
  const pageTitle = titleOrUrl.includes("elanthipedia.play.net")
    ? decodeURIComponent(titleOrUrl.split("/").pop() ?? titleOrUrl)
    : titleOrUrl;

  const parseUrl = new URL(API_BASE);
  parseUrl.searchParams.set("action", "parse");
  parseUrl.searchParams.set("page", pageTitle);
  parseUrl.searchParams.set("prop", "text");
  parseUrl.searchParams.set("format", "json");
  parseUrl.searchParams.set("formatversion", "2");

  const response = await fetch(parseUrl);
  if (!response.ok) {
    throw new Error(`Elanthipedia page fetch failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    parse?: { title: string; pageid: number; text: string };
    error?: { info?: string };
  };

  if (data.error) {
    throw new Error(data.error.info ?? "Elanthipedia returned an unknown error.");
  }

  if (!data.parse?.text || !data.parse?.title) {
    throw new Error("Could not parse page content from Elanthipedia response.");
  }

  return {
    title: data.parse.title,
    html: data.parse.text
  };
}

export async function searchElanthipedia(query: string, limit = 5): Promise<ElanthipediaSearchResult[]> {
  const url = new URL(API_BASE);
  url.searchParams.set("action", "opensearch");
  url.searchParams.set("search", query);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("namespace", "0");
  url.searchParams.set("format", "json");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Elanthipedia search failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as [string, string[], string[], string[]];
  const titles = data[1] ?? [];
  const descriptions = data[2] ?? [];
  const links = data[3] ?? [];

  return titles.map((title, index) => ({
    title,
    description: descriptions[index] ?? "",
    url: links[index] ?? ""
  }));
}

export async function getElanthipediaPage(titleOrUrl: string): Promise<ElanthipediaPage> {
  const { title, html } = await parsePageHtml(titleOrUrl);
  const $ = cheerio.load(html);
  $("table, script, style, .reference, .navbox").remove();
  const text = normalizeWhitespace($.text());

  return {
    title,
    url: `https://elanthipedia.play.net/${encodeURIComponent(title)}`,
    text
  };
}

export async function getSkill(skill: string): Promise<ElanthipediaPage> {
  const trimmed = skill.trim();
  if (!trimmed) {
    throw new Error("Skill must be non-empty.");
  }

  if (trimmed.includes("elanthipedia.play.net")) {
    return getElanthipediaPage(trimmed);
  }

  const normalized = toTitleCase(trimmed);
  const candidates = [normalized, `${normalized} skill`];
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      return await getElanthipediaPage(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    lastError instanceof Error ? lastError.message : `Could not find skill page for '${skill}'.`
  );
}

export async function getGuildSkills(guild: string): Promise<GuildSkill[]> {
  const guildName = guild.trim();
  if (!guildName) {
    throw new Error("Guild must be non-empty.");
  }

  const { html } = await parsePageHtml("Guild_Skills");
  const $ = cheerio.load(html);
  const normalizedGuild = normalizeForMatch(guildName);
  const results: GuildSkill[] = [];

  $("table.wikitable tr").each((_index, row) => {
    const columns = $(row).find("th, td");
    if (columns.length < 5) {
      return;
    }

    const firstCell = normalizeWhitespace($(columns[0]).text());
    const secondCell = normalizeWhitespace($(columns[1]).text());

    if (!firstCell || !secondCell || firstCell.toLowerCase() === "skill") {
      return;
    }

    const normalizedPageGuild = normalizeForMatch(secondCell);
    const guildMatches =
      normalizedPageGuild.includes(normalizedGuild) || normalizedGuild.includes(normalizedPageGuild);

    if (!guildMatches) {
      return;
    }

    const skillPageTitle = firstCell.replace(/\s+/g, "_");

    results.push({
      skill: firstCell,
      guild: secondCell,
      skillset: normalizeWhitespace($(columns[2]).text()),
      training: normalizeWhitespace($(columns[3]).text()),
      bonus: normalizeWhitespace($(columns[4]).text()),
      url: `https://elanthipedia.play.net/${encodeURIComponent(skillPageTitle)}`
    });
  });

  return results;
}
