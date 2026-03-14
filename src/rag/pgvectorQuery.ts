import { Client } from "pg";
import { embedText, getPgvectorEnv, parseCliArgs, toPgVectorLiteral } from "./pgvectorCommon.js";

type QueryRow = {
  chunk_id: string;
  title: string;
  heading_path: string;
  url: string;
  text_content: string;
  distance: number;
};

function parseOptions(): { query: string; limit: number; json: boolean } {
  const args = parseCliArgs(process.argv.slice(2));
  const query = String(args.q ?? args.query ?? "").trim();
  const limit = Number(args.k ?? args.limit ?? "8");
  const json = Boolean(args.json);

  if (!query) {
    throw new Error("Provide a query with --q \"...\".");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("--k/--limit must be an integer between 1 and 50.");
  }

  return { query, limit, json };
}

function trimText(value: string, maxLength = 280): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

async function main(): Promise<void> {
  const env = getPgvectorEnv();
  const options = parseOptions();
  const embedding = await embedText(options.query, env);

  if (embedding.length !== env.vectorDim) {
    throw new Error(
      `Embedding dimension mismatch for query vector: expected ${env.vectorDim}, got ${embedding.length}`
    );
  }

  const client = new Client({ connectionString: env.pgUrl });
  await client.connect();

  try {
    const result = await client.query<QueryRow>(
      `
        SELECT
          chunk_id,
          title,
          heading_path,
          url,
          text_content,
          (embedding <=> $1::vector) AS distance
        FROM rag_chunks
        ORDER BY embedding <=> $1::vector ASC
        LIMIT $2
      `,
      [toPgVectorLiteral(embedding), options.limit]
    );

    if (options.json) {
      const payload = result.rows.map((row) => ({
        chunk_id: row.chunk_id,
        title: row.title,
        heading_path: row.heading_path,
        url: row.url,
        distance: row.distance,
        similarity: 1 - row.distance,
        snippet: trimText(row.text_content)
      }));
      console.log(JSON.stringify({ query: options.query, results: payload }, null, 2));
      return;
    }

    console.log(`Query: ${options.query}`);
    console.log(`Top ${result.rows.length} results:`);
    for (const [index, row] of result.rows.entries()) {
      console.log(
        `\n${index + 1}. ${row.title} :: ${row.heading_path || "(lead)"}` +
          `\n   URL: ${row.url}` +
          `\n   Similarity: ${(1 - row.distance).toFixed(4)}` +
          `\n   Snippet: ${trimText(row.text_content)}`
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
