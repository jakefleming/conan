# Conan Indexing Layer — Implementation Plan

## Problem

Conan currently sends the entire directory's worth of files/annotations to Claude on every chat request. This works fine for a designer with 20-60 images from a session. It falls apart when someone like Zac has hundreds of meeting transcripts across months — you can't stuff 6 months of 1:1 notes into a single API call.

## Goals

1. **Scalable retrieval** — Chat can answer questions across hundreds or thousands of files without sending everything in one request
2. **Structured queries** — "What commitments did I make to Sarah in Q1?" should find the right 5 files out of 500
3. **Automatic indexing** — New files get processed without manual intervention
4. **Files remain the source of truth** — The index is a read-optimized layer that can always be rebuilt

## Architecture

```
                    ┌──────────────┐
                    │  Raw Files   │  ← source of truth
                    │  .context.json│
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   Indexer    │  ← background process
                    │  (on change) │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  conan.db   │  ← SQLite index
                    │  (read-opt)  │
                    └──────┬───────┘
                           │
              ┌────────────▼────────────┐
              │    Chat / Query Layer   │
              │  Claude calls search()  │
              │  gets relevant files    │
              │  then reasons over them │
              └─────────────────────────┘
```

## SQLite Schema

```sql
-- Every file we've seen
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,        -- relative path from project root
  dir TEXT NOT NULL,                 -- parent directory
  name TEXT NOT NULL,                -- filename
  ext TEXT NOT NULL,                 -- .txt, .jpeg, etc
  size INTEGER,
  modified_at TEXT,                  -- file mtime
  indexed_at TEXT,                   -- when we last processed it
  content_hash TEXT,                 -- detect changes
  file_type TEXT                     -- 'image', 'text', 'pdf', 'other'
);

-- Extracted structured data from each file
-- One file can produce multiple chunks (e.g., a meeting transcript has
-- multiple decisions, action items, etc.)
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  file_id INTEGER REFERENCES files(id),
  chunk_type TEXT NOT NULL,          -- 'summary', 'decision', 'action_item',
                                     -- 'commitment', 'question', 'note',
                                     -- 'annotation', 'full_text'
  content TEXT NOT NULL,             -- the extracted text
  people TEXT,                       -- comma-separated names mentioned
  date_ref TEXT,                     -- date referenced in content, if any
  created_at TEXT,
  embedding BLOB                    -- future: vector embedding for semantic search
);

-- User annotations from .context.json
CREATE TABLE annotations (
  id INTEGER PRIMARY KEY,
  file_id INTEGER REFERENCES files(id),
  comment_index INTEGER,
  author TEXT NOT NULL,              -- 'user' or 'claude'
  text TEXT NOT NULL,
  region_json TEXT,                  -- nullable JSON of {x,y,w,h}
  attachments_json TEXT,             -- nullable JSON array
  created_at TEXT
);

-- FTS5 virtual table for fast text search
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  people,
  content='chunks',
  content_rowid='id'
);

CREATE VIRTUAL TABLE annotations_fts USING fts5(
  text,
  content='annotations',
  content_rowid='id'
);
```

## Indexing Pipeline

### When does indexing run?

**Option A: Background watcher (daemon)**
- Use `fs.watch` (recursive) on the project directory
- On file change/add, queue for processing
- Debounce to avoid re-indexing on rapid saves

**Option B: On-demand + periodic**
- Index on app startup (scan for changes)
- Re-index when chat is opened or a query is made (check for stale entries)
- Manual "Reindex" button in UI

**Recommendation: Option A with Option B as fallback.** The watcher handles live changes; startup scan catches anything missed while the server was off.

### What does processing look like?

For each new/changed file:

1. **Hash the file** to detect changes (reuse existing `computeFileHash`)
2. **Skip if unchanged** (hash matches `files.content_hash`)
3. **Extract raw content:**
   - Text files: read content directly
   - PDFs: extract text (could use Claude or a library)
   - Images: use existing thumbnail + any annotations
4. **Send to Claude for structured extraction:**
   ```
   Extract structured information from this document:
   - Summary (2-3 sentences)
   - Decisions made (who decided what)
   - Action items / commitments (who committed to what, by when)
   - People mentioned
   - Key topics/themes
   - Dates referenced

   Return as JSON.
   ```
5. **Store chunks** in SQLite with extracted metadata
6. **Sync annotations** from `.context.json` into the annotations table
7. **Update FTS indexes**

### Cost consideration

Claude API calls per file add up. For Zac's use case (dozens of meetings/week), we should:
- Only re-process changed files (hash check)
- Use `haiku` for extraction (cheaper, fast enough for structured extraction)
- Batch multiple small files into one API call where possible
- Make extraction optional / configurable

## Chat Integration (RAG)

### New tool for Claude: `search_index`

Add a second tool alongside `show_files`:

```typescript
{
  name: "search_index",
  description: "Search the project index for files and information matching a query. Use this when the user asks about topics, people, decisions, or commitments that may span many files. Returns relevant excerpts with file references.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language search query" },
      filters: {
        type: "object",
        properties: {
          people: { type: "array", items: { type: "string" }, description: "Filter by people mentioned" },
          chunk_type: { type: "array", items: { type: "string" }, description: "Filter by type: decision, action_item, commitment, etc." },
          date_from: { type: "string", description: "ISO date, earliest" },
          date_to: { type: "string", description: "ISO date, latest" },
          directory: { type: "string", description: "Limit to specific subdirectory" }
        }
      },
      limit: { type: "number", description: "Max results (default 10)" }
    },
    required: ["query"]
  }
}
```

### How chat changes

Current flow:
```
User asks question → Send ALL context to Claude → Get answer
```

New flow:
```
User asks question → Claude decides if it needs to search →
  If yes: calls search_index tool → gets relevant chunks →
  Claude reasons over the chunks + current directory context → Get answer
  If no: uses current directory context as before (small projects)
```

This is a **tool-use loop**: the server handles the tool call, queries SQLite, returns results, and Claude continues with the enriched context. The current directory's annotations are still included as baseline context (for the common case of "tell me about this file"), but Claude can reach beyond via search.

### Multi-turn tool use

The Claude API supports multi-turn tool use natively. The server needs to:
1. Send initial request with tools
2. If response contains `tool_use`, execute the tool
3. Send tool result back to Claude
4. Get final response

This means the chat endpoint becomes a loop rather than a single request/response.

## UI Changes

### Minimal UI additions

1. **Index status indicator** — small dot/badge in the topbar showing indexing state:
   - Green: index up to date
   - Yellow/spinning: indexing in progress
   - Gray: index empty (needs initial build)

2. **"Reindex" button** — in settings or topbar, force a full reindex

3. **Index stats** — somewhere unobtrusive: "342 files indexed, 1,847 chunks"

### No other UI changes needed

The beauty of the tool-use approach is the chat interface stays the same. Users just ask questions. Claude decides when to search. The smart cards already exist for presenting file collections.

## Implementation Steps

### Phase 1: SQLite foundation
- [ ] Add `bun:sqlite` (built into Bun, no dependency needed)
- [ ] Create DB schema, migration on startup
- [ ] Write CRUD helpers for files, chunks, annotations tables
- [ ] Sync existing `.context.json` annotations into DB on startup

### Phase 2: File watcher + text indexing
- [ ] Add `fs.watch` recursive watcher on project directory
- [ ] On file change: hash, detect new/changed, extract text content
- [ ] Store raw text as `full_text` chunks
- [ ] Populate FTS indexes
- [ ] Add startup scan to catch up on missed changes

### Phase 3: Claude extraction pipeline
- [ ] Define extraction prompt for structured data (decisions, action items, people, etc.)
- [ ] Process new/changed files through Claude (haiku) for chunk extraction
- [ ] Store extracted chunks with metadata
- [ ] Add queue/rate limiting to avoid API spam on large initial imports
- [ ] Make extraction configurable (can be disabled for cost reasons)

### Phase 4: RAG chat integration
- [ ] Add `search_index` tool to chat endpoint
- [ ] Implement tool execution: FTS query + optional filters → return chunks
- [ ] Implement multi-turn tool-use loop in chat endpoint
- [ ] Keep current directory context as baseline, search as supplement
- [ ] Test with large corpus (hundreds of files)

### Phase 5: UI polish
- [ ] Index status indicator
- [ ] Reindex button
- [ ] Index stats display

## Open Questions

1. **Vector embeddings?** FTS5 is great for keyword search but misses semantic similarity. We could add embeddings later (Anthropic's embedding API or local model). The `embedding BLOB` column is there as a placeholder.

2. **Cross-project search?** If you switch folders, should the old index persist? Probably yes — one DB per project root, stored as `conan.db` in the project directory.

3. **Extraction model choice?** Haiku is cheap and fast but may miss nuance. Sonnet is better but 10x the cost. Could make it configurable or use Haiku for initial pass, Sonnet for re-extraction on demand.

4. **Privacy?** Meeting notes are sensitive. Everything stays local (SQLite on disk, Claude API calls are the same ones already being made). But worth noting: the extraction pipeline sends file content to the Claude API, same as chat/summary already do.
