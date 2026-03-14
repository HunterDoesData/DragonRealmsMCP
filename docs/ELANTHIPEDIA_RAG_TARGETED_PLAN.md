# Elanthipedia Targeted RAG Plan (Hot-Set First)

## Goal
Create a high-signal RAG index from selected Elanthipedia areas instead of indexing the entire site at once.

This gives:
- Faster rollout
- Lower embedding/storage cost
- Better precision on gameplay queries
- Controlled expansion as coverage gaps are discovered

---

## 1) Crawl Scope and Compliance

## Source
- Site: `https://elanthipedia.play.net`
- Prefer MediaWiki API for page inventory + revisions.
- Use HTML fetch for section-aware extraction when needed.

## Respectful ingestion defaults
- User-Agent: `DragonRealmsMCP-RAG/0.1 (+local-dev)`
- Concurrency: 2-4
- Rate limit: 1-2 requests/second baseline
- Retry: exponential backoff, max 3
- Honor robots and wiki rate expectations.

## Initial hot-set scope
Index only high-value gameplay content first:
- Skills and training pages
- Spell pages
- Combat mechanics pages
- Commands and syntax pages
- Survival/crafting essentials (foraging, alchemy, first aid, etc.)

Use allowlists by category, page title prefixes, or explicit page lists.

---

## 2) Canonical Extraction Design

## Canonical page identity
For every page, store:
- `page_id`
- `title`
- `canonical_url`
- `revision_id`
- `updated_at`
- `namespace`
- `categories[]`
- `redirect_target` (if applicable)

## Section-aware extraction
Extract meaningful blocks only:
- Lead summary
- Mechanics sections
- Syntax/usage sections
- Tables that contain formulas, prerequisites, or command forms

Strip boilerplate/noise:
- nav/footer/edit links
- template chrome not containing gameplay facts
- scripts/styles

## Section object
Each extracted unit before chunking:
- `section_id` (stable hash of `title + heading path + revision_id`)
- `heading_path` (e.g., `Magic > Debilitation > Usage`)
- `raw_text`
- `source_offsets` (start/end if available)

---

## 3) Chunking and Token Policy

## Chunk targets
- Default chunk size: 650 tokens
- Overlap: 100 tokens
- Minimum chunk length: 120 tokens (unless table/list chunk)
- Hard max chunk: 900 tokens

## Preserve structure
- Never merge across top-level headings.
- Keep list and table entries grouped with their local heading.
- For command syntax sections, use smaller chunks (250-450 tokens).

## Chunk metadata schema
Each chunk should include:
- `doc_id` (stable)
- `chunk_id` (stable)
- `title`
- `heading_path`
- `url`
- `revision_id`
- `updated_at`
- `category_tags[]`
- `topic_tags[]`
- `guild_tags[]` (if derivable)
- `skill_tags[]` (if derivable)
- `token_count`

---

## 4) Retrieval Pipeline (Hybrid)

## Index strategy
Use two retrieval channels:
- Dense vector index for semantic recall
- Sparse/BM25 for exact term recall (commands, abbreviations, spell names)

## Query flow
1. Query rewrite (lightweight normalization only)
2. Retrieve:
   - Dense top-k (e.g., 24)
   - Sparse top-k (e.g., 24)
3. Merge + dedupe by `doc_id/chunk_id`
4. Rerank top 30 -> top 8-12
5. Context pack with diversity constraints (avoid all chunks from same page)

## Defaults for quality
- Favor chunks with newer `updated_at` when scores tie.
- Add strict max chunks per page (e.g., 3) to reduce redundancy.

---

## 5) Citations and Safety

## Citation contract
Every answer should cite:
- `title`
- `heading_path`
- `url`

## Safety filters
- Strip prompt-injection-like instructions from source text during ingestion and pre-answer packing.
- Ignore off-domain links unless explicitly whitelisted.
- If retrieval confidence is low, return “insufficient evidence” instead of fabricating.

---

## 6) Incremental Updates

## Freshness model
- Initial full ingest for the hot-set
- Incremental sync every 24h (or 6h if needed)
- Weekly integrity pass:
  - detect moved/redirected pages
  - remove deleted pages/chunks
  - refresh category membership drift

## Re-index policy
- Re-embed only changed sections/pages (revision-aware)
- Tombstone stale chunks by `doc_id + revision_id`

---

## 7) Evaluation (Before Broad Rollout)

Track at least:
- Recall@k on a curated DR question set
- Citation accuracy (% claims backed by cited text)
- Faithfulness score (manual spot checks)
- Miss rate (% queries where no strong evidence is retrieved)

Start with 50-100 representative gameplay questions, then grow to 250+.

---

## 8) Suggested Implementation Order

1. Build page inventory + canonical metadata store
2. Implement section extraction for hot-set pages
3. Implement chunking + metadata enrichment
4. Build dense+sparse indices
5. Add reranker + citation formatter
6. Add incremental updater and evaluation harness
7. Expand hot-set categories based on miss analysis

---

## 9) Expansion Policy (After Hot-Set)

Only expand when one of these is true:
- Miss rate for a topic remains high
- Users repeatedly ask uncovered domains
- Existing citations point to low-confidence chunks

Expand by category batch, not whole-site at once.
