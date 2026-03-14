import { readFile } from "node:fs/promises";
import path from "node:path";

export type EmbedProvider = "ollama" | "openai";

export type PgvectorEnv = {
  pgUrl: string;
  vectorDim: number;
  embedProvider: EmbedProvider;
  embedMaxChars: number;
  ollamaBaseUrl: string;
  ollamaModel: string;
  openAiApiKey: string;
  openAiModel: string;
};

export type RagChunkRecord = {
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

export function parseCliArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      continue;
    }
    const normalizedKey = key.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      args[normalizedKey] = true;
      continue;
    }
    args[normalizedKey] = value;
    i += 1;
  }
  return args;
}

export function getPgvectorEnv(): PgvectorEnv {
  const pgUrl =
    process.env.RAG_PGURL ??
    "postgres://postgres:postgres@127.0.0.1:5432/dragonrealms_rag";
  const vectorDim = Number(process.env.RAG_VECTOR_DIM ?? "768");
  const embedProvider = (process.env.RAG_EMBED_PROVIDER ?? "ollama").toLowerCase() as EmbedProvider;

  if (!Number.isFinite(vectorDim) || vectorDim <= 0) {
    throw new Error("RAG_VECTOR_DIM must be a positive integer.");
  }

  if (embedProvider !== "ollama" && embedProvider !== "openai") {
    throw new Error("RAG_EMBED_PROVIDER must be either 'ollama' or 'openai'.");
  }

  const openAiApiKey =
    process.env.OPENAI_API_KEY?.trim() ?? process.env.OPENAIKEY?.trim() ?? "";

  const embedMaxChars = Number(process.env.RAG_EMBED_MAX_CHARS ?? "4500");
  if (!Number.isFinite(embedMaxChars) || embedMaxChars < 256) {
    throw new Error("RAG_EMBED_MAX_CHARS must be a number >= 256.");
  }

  return {
    pgUrl,
    vectorDim,
    embedProvider,
    embedMaxChars,
    ollamaBaseUrl: process.env.RAG_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    ollamaModel: process.env.RAG_OLLAMA_MODEL ?? "nomic-embed-text",
    openAiApiKey,
    openAiModel: process.env.RAG_OPENAI_EMBED_MODEL ?? "text-embedding-3-small"
  };
}

export function toPgVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export async function loadChunksJsonl(filePath: string): Promise<RagChunkRecord[]> {
  const resolved = path.resolve(filePath);
  const raw = await readFile(resolved, "utf8");
  const lines = raw.split(/\n/).filter((line) => line.trim().length > 0);
  const chunks: RagChunkRecord[] = [];

  for (const line of lines) {
    const parsed = JSON.parse(line) as RagChunkRecord;
    if (!parsed.chunk_id || !parsed.text) {
      continue;
    }
    chunks.push(parsed);
  }

  return chunks;
}

export async function embedText(text: string, env: PgvectorEnv): Promise<number[]> {
  const normalized = text.replace(/\s+/g, " ").trim();
  const bounded = normalized.length > env.embedMaxChars
    ? normalized.slice(0, env.embedMaxChars)
    : normalized;

  if (env.embedProvider === "ollama") {
    return embedWithOllama(bounded, env);
  }
  return embedWithOpenAi(bounded, env);
}

async function embedWithOllama(text: string, env: PgvectorEnv): Promise<number[]> {
  const endpoint = `${env.ollamaBaseUrl.replace(/\/$/, "")}/api/embeddings`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.ollamaModel,
      prompt: text
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText} :: ${body}`);
  }

  const payload = (await response.json()) as { embedding?: number[] };
  if (!payload.embedding || payload.embedding.length === 0) {
    throw new Error("Ollama returned an empty embedding.");
  }
  return payload.embedding;
}

async function embedWithOpenAi(text: string, env: PgvectorEnv): Promise<number[]> {
  if (!env.openAiApiKey) {
    throw new Error("OPENAI_API_KEY/OPENAIKEY is required when RAG_EMBED_PROVIDER=openai.");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.openAiApiKey}`
    },
    body: JSON.stringify({
      model: env.openAiModel,
      input: text
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI embedding failed: ${response.status} ${response.statusText} :: ${body}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const vector = payload.data?.[0]?.embedding;
  if (!vector || vector.length === 0) {
    throw new Error("OpenAI returned an empty embedding.");
  }
  return vector;
}
