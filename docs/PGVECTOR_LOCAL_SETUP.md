# Local pgvector Setup (Contained RAG)

This setup keeps retrieval local to your machine:
- Elanthipedia chunks from `data/rag/elanthipedia-chunks.jsonl`
- Local embedding model via Ollama (default)
- Local vector storage in PostgreSQL + pgvector

## 1) Start local pgvector

```bash
docker compose -f docker-compose.pgvector.yml up -d
```

## 2) Configure environment

Copy `.env.example` to `.env` and ensure:

- `RAG_PGURL` points to your local database
- `RAG_VECTOR_DIM` matches the embedding model dimension
- `RAG_EMBED_PROVIDER=ollama` for local embeddings
- `RAG_OLLAMA_MODEL=nomic-embed-text` (or your preferred local embedding model)

If using Ollama, ensure it is running and model is pulled:

```bash
ollama pull nomic-embed-text
```

## 3) Initialize schema

```bash
npm run rag:pg:init
```

Creates:
- `vector` extension
- `rag_chunks` table
- supporting indexes

## 4) Embed + upsert ingested chunks

```bash
npm run rag:embed:pgvector
```

Optional flags:
- `--input data/rag/elanthipedia-chunks.jsonl`
- `--force` to re-embed all chunks

## 5) Query semantic retrieval

```bash
npm run rag:query:pgvector -- --q "how do i train defenses efficiently" --k 8
```

JSON output:

```bash
npm run rag:query:pgvector -- --q "best empath healing spell" --k 5 --json
```

## Notes

- Keep `RAG_VECTOR_DIM` consistent with your embedding model output.
- If dimensions mismatch, rerun schema init with the correct dimension and re-embed.
- This is local-first and does not require managed vector infrastructure.
- `elanthipedia_rag_query` applies `RAG_MIN_SIMILARITY` and will return an insufficient-evidence response when results are below threshold.
