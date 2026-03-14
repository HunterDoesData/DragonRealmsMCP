import { Client } from "pg";
import { embedText, getPgvectorEnv, toPgVectorLiteral } from "./pgvectorCommon.js";

export type RagSearchResult = {
  chunkId: string;
  title: string;
  headingPath: string;
  url: string;
  text: string;
  similarity: number;
};

type SearchOptions = {
  hybrid?: boolean;
  semanticPool?: number;
  keywordPool?: number;
};

type QueryRow = {
  chunk_id: string;
  title: string;
  heading_path: string;
  url: string;
  text_content: string;
  distance: number;
};

type KeywordRow = {
  chunk_id: string;
  title: string;
  heading_path: string;
  url: string;
  text_content: string;
  rank: number;
};

function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("limit must be an integer between 1 and 25");
  }
  return limit;
}

export async function queryPgvector(
  query: string,
  limit = 8,
  overrides: SearchOptions = {}
): Promise<RagSearchResult[]> {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    throw new Error("query must be non-empty");
  }

  const env = getPgvectorEnv();
  const topK = normalizeLimit(limit);
  const options: Required<SearchOptions> = {
    hybrid: overrides.hybrid ?? true,
    semanticPool: overrides.semanticPool ?? Math.max(topK * 3, 20),
    keywordPool: overrides.keywordPool ?? Math.max(topK * 3, 20)
  };
  const embedding = await embedText(cleanQuery, env);
  if (embedding.length !== env.vectorDim) {
    throw new Error(`Embedding dimension mismatch: expected ${env.vectorDim}, got ${embedding.length}`);
  }

  const client = new Client({ connectionString: env.pgUrl });
  await client.connect();

  try {
    const semantic = await client.query<QueryRow>(
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
      [toPgVectorLiteral(embedding), options.semanticPool]
    );

    let keywordRows: KeywordRow[] = [];
    if (options.hybrid) {
      const keyword = await client.query<KeywordRow>(
        `
          SELECT
            chunk_id,
            title,
            heading_path,
            url,
            text_content,
            ts_rank_cd(
              to_tsvector('english', coalesce(title, '') || ' ' || coalesce(heading_path, '') || ' ' || coalesce(text_content, '')),
              websearch_to_tsquery('english', $1)
            ) AS rank
          FROM rag_chunks
          WHERE to_tsvector('english', coalesce(title, '') || ' ' || coalesce(heading_path, '') || ' ' || coalesce(text_content, '')) @@ websearch_to_tsquery('english', $1)
          ORDER BY rank DESC
          LIMIT $2
        `,
        [cleanQuery, options.keywordPool]
      );
      keywordRows = keyword.rows;
    }

    const fused = new Map<string, {
      chunkId: string;
      title: string;
      headingPath: string;
      url: string;
      text: string;
      semanticSimilarity: number;
      score: number;
    }>();

    semantic.rows.forEach((row, index) => {
      const similarity = 1 - row.distance;
      const rrf = 1 / (60 + index + 1);
      fused.set(row.chunk_id, {
        chunkId: row.chunk_id,
        title: row.title,
        headingPath: row.heading_path,
        url: row.url,
        text: row.text_content,
        semanticSimilarity: similarity,
        score: rrf
      });
    });

    keywordRows.forEach((row, index) => {
      const rrf = 1 / (60 + index + 1);
      const existing = fused.get(row.chunk_id);
      if (existing) {
        existing.score += rrf;
        return;
      }

      fused.set(row.chunk_id, {
        chunkId: row.chunk_id,
        title: row.title,
        headingPath: row.heading_path,
        url: row.url,
        text: row.text_content,
        semanticSimilarity: Math.max(0, Math.min(1, row.rank)),
        score: rrf
      });
    });

    return Array.from(fused.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((entry) => ({
        chunkId: entry.chunkId,
        title: entry.title,
        headingPath: entry.headingPath,
        url: entry.url,
        text: entry.text,
        similarity: entry.semanticSimilarity
      }));
  } finally {
    await client.end();
  }
}
