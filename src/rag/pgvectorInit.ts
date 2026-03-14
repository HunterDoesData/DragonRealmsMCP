import { Client } from "pg";
import { getPgvectorEnv } from "./pgvectorCommon.js";

function validateVectorDim(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 8192) {
    throw new Error("RAG_VECTOR_DIM must be an integer between 1 and 8192.");
  }
  return value;
}

async function main(): Promise<void> {
  const env = getPgvectorEnv();
  const vectorDim = validateVectorDim(env.vectorDim);

  const client = new Client({ connectionString: env.pgUrl });
  await client.connect();

  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");

    await client.query(`
      CREATE TABLE IF NOT EXISTS rag_chunks (
        chunk_id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        title TEXT NOT NULL,
        heading_path TEXT NOT NULL,
        url TEXT NOT NULL,
        revision_id BIGINT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        category_tags TEXT[] NOT NULL DEFAULT '{}',
        topic_tags TEXT[] NOT NULL DEFAULT '{}',
        guild_tags TEXT[] NOT NULL DEFAULT '{}',
        skill_tags TEXT[] NOT NULL DEFAULT '{}',
        token_count INTEGER NOT NULL,
        text_content TEXT NOT NULL,
        embedding VECTOR(${vectorDim}) NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_row_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query("CREATE INDEX IF NOT EXISTS rag_chunks_doc_id_idx ON rag_chunks (doc_id)");
    await client.query("CREATE INDEX IF NOT EXISTS rag_chunks_updated_at_idx ON rag_chunks (updated_at DESC)");
    await client.query(
      "CREATE INDEX IF NOT EXISTS rag_chunks_embedding_ivfflat_idx ON rag_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)"
    );

    console.log("pgvector schema initialized.");
    console.log(`Database: ${env.pgUrl}`);
    console.log(`Vector dimensions: ${vectorDim}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
