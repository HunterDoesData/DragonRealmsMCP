import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import {
  embedText,
  getPgvectorEnv,
  loadChunksJsonl,
  parseCliArgs,
  toPgVectorLiteral,
  type RagChunkRecord
} from "./pgvectorCommon.js";

type DeltaPageRecord = {
  title: string;
  canonical_url: string;
};

type EmbedDeltaOptions = {
  deltaChunksPath: string;
  deltaPagesPath: string;
};

function parseOptions(): EmbedDeltaOptions {
  const args = parseCliArgs(process.argv.slice(2));
  return {
    deltaChunksPath: String(args.deltaChunks ?? "data/rag/delta/elanthipedia-chunks.delta.jsonl"),
    deltaPagesPath: String(args.deltaPages ?? "data/rag/delta/elanthipedia-pages.delta.jsonl")
  };
}

async function loadDeltaPages(filePath: string): Promise<DeltaPageRecord[]> {
  const resolved = path.resolve(filePath);
  try {
    const raw = await readFile(resolved, "utf8");
    return raw
      .split(/\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as DeltaPageRecord)
      .filter((page) => page.canonical_url);
  } catch {
    return [];
  }
}

async function upsertChunk(client: Client, chunk: RagChunkRecord, embedding: number[]): Promise<void> {
  const metadata = {
    title: chunk.title,
    heading_path: chunk.heading_path,
    url: chunk.url,
    revision_id: chunk.revision_id,
    updated_at: chunk.updated_at,
    category_tags: chunk.category_tags,
    topic_tags: chunk.topic_tags,
    guild_tags: chunk.guild_tags,
    skill_tags: chunk.skill_tags,
    token_count: chunk.token_count
  };

  await client.query(
    `
      INSERT INTO rag_chunks (
        chunk_id,
        doc_id,
        title,
        heading_path,
        url,
        revision_id,
        updated_at,
        category_tags,
        topic_tags,
        guild_tags,
        skill_tags,
        token_count,
        text_content,
        embedding,
        metadata,
        updated_row_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7::timestamptz,
        $8::text[], $9::text[], $10::text[], $11::text[],
        $12, $13, $14::vector, $15::jsonb, now()
      )
      ON CONFLICT (chunk_id)
      DO UPDATE SET
        doc_id = EXCLUDED.doc_id,
        title = EXCLUDED.title,
        heading_path = EXCLUDED.heading_path,
        url = EXCLUDED.url,
        revision_id = EXCLUDED.revision_id,
        updated_at = EXCLUDED.updated_at,
        category_tags = EXCLUDED.category_tags,
        topic_tags = EXCLUDED.topic_tags,
        guild_tags = EXCLUDED.guild_tags,
        skill_tags = EXCLUDED.skill_tags,
        token_count = EXCLUDED.token_count,
        text_content = EXCLUDED.text_content,
        embedding = EXCLUDED.embedding,
        metadata = EXCLUDED.metadata,
        updated_row_at = now()
    `,
    [
      chunk.chunk_id,
      chunk.doc_id,
      chunk.title,
      chunk.heading_path,
      chunk.url,
      chunk.revision_id,
      chunk.updated_at,
      chunk.category_tags,
      chunk.topic_tags,
      chunk.guild_tags,
      chunk.skill_tags,
      chunk.token_count,
      chunk.text,
      toPgVectorLiteral(embedding),
      JSON.stringify(metadata)
    ]
  );
}

async function main(): Promise<void> {
  const env = getPgvectorEnv();
  const options = parseOptions();
  const deltaChunks = await loadChunksJsonl(options.deltaChunksPath);
  const deltaPages = await loadDeltaPages(options.deltaPagesPath);

  if (deltaChunks.length === 0 && deltaPages.length === 0) {
    console.log("No delta changes detected. Nothing to embed.");
    return;
  }

  const uniqueChunks = Array.from(new Map(deltaChunks.map((chunk) => [chunk.chunk_id, chunk])).values());
  const affectedUrls = Array.from(new Set(deltaPages.map((page) => page.canonical_url)));

  const client = new Client({ connectionString: env.pgUrl });
  await client.connect();

  try {
    if (affectedUrls.length > 0) {
      await client.query("DELETE FROM rag_chunks WHERE url = ANY($1::text[])", [affectedUrls]);
    }

    let completed = 0;
    for (const chunk of uniqueChunks) {
      const embedding = await embedText(chunk.text, env);
      if (embedding.length !== env.vectorDim) {
        throw new Error(
          `Embedding dimension mismatch for chunk ${chunk.chunk_id}: expected ${env.vectorDim}, got ${embedding.length}`
        );
      }

      await upsertChunk(client, chunk, embedding);
      completed += 1;
      if (completed % 25 === 0 || completed === uniqueChunks.length) {
        console.log(`Embedded delta chunks ${completed}/${uniqueChunks.length}`);
      }
    }
  } finally {
    await client.end();
  }

  console.log(`Delta embed complete. ReplacedUrls=${affectedUrls.length}, Embedded=${uniqueChunks.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
