import { Client } from "pg";
import {
  embedText,
  getPgvectorEnv,
  loadChunksJsonl,
  parseCliArgs,
  toPgVectorLiteral,
  type RagChunkRecord
} from "./pgvectorCommon.js";

type EmbedOptions = {
  inputPath: string;
  batchSize: number;
  force: boolean;
};

function parseOptions(): EmbedOptions {
  const args = parseCliArgs(process.argv.slice(2));
  const inputPath = String(args.input ?? "data/rag/elanthipedia-chunks.jsonl");
  const batchSize = Number(args.batch ?? "1");
  const force = Boolean(args.force);

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 64) {
    throw new Error("--batch must be an integer between 1 and 64.");
  }

  return { inputPath, batchSize, force };
}

function mapByChunkId(chunks: RagChunkRecord[]): Map<string, RagChunkRecord> {
  const map = new Map<string, RagChunkRecord>();
  for (const chunk of chunks) {
    map.set(chunk.chunk_id, chunk);
  }
  return map;
}

async function fetchExistingChunkIds(client: Client): Promise<Set<string>> {
  const result = await client.query<{ chunk_id: string }>("SELECT chunk_id FROM rag_chunks");
  return new Set(result.rows.map((row) => row.chunk_id));
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

  const allChunks = await loadChunksJsonl(options.inputPath);
  if (allChunks.length === 0) {
    console.log("No chunks found in input JSONL.");
    return;
  }

  const uniqueChunks = Array.from(mapByChunkId(allChunks).values());

  const client = new Client({ connectionString: env.pgUrl });
  await client.connect();

  try {
    const existingIds = options.force ? new Set<string>() : await fetchExistingChunkIds(client);
    const pending = uniqueChunks.filter((chunk) => !existingIds.has(chunk.chunk_id));

    console.log(`Input chunks: ${uniqueChunks.length}`);
    console.log(`Existing chunks: ${existingIds.size}`);
    console.log(`Pending embeds: ${pending.length}`);
    console.log(`Provider: ${env.embedProvider}`);

    let completed = 0;
    for (const chunk of pending) {
      const embedding = await embedText(chunk.text, env);
      if (embedding.length !== env.vectorDim) {
        throw new Error(
          `Embedding dimension mismatch for chunk ${chunk.chunk_id}: expected ${env.vectorDim}, got ${embedding.length}`
        );
      }

      await upsertChunk(client, chunk, embedding);
      completed += 1;

      if (completed % 25 === 0 || completed === pending.length) {
        console.log(`Embedded ${completed}/${pending.length}`);
      }
    }

    console.log("Embedding upsert complete.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
