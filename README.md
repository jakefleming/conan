# Conan - Context Annotator

A local-first tool for capturing and synthesizing context from in-person product and design sessions. Point it at a folder of photos, sketches, or documents, then walk through each one adding voice or text annotations. When you're done, generate an AI-powered summary that links back to every source comment and image.

## Quick Start

```bash
bun run server.ts /path/to/your/session-folder
```

Then open [http://localhost:3333](http://localhost:3333).

Your session folder should contain the images, PDFs, or documents you want to annotate. Subdirectories are fully supported — browse into them via the grid and breadcrumb navigation.

## Requirements

- [Bun](https://bun.sh) runtime
- An [Anthropic API key](https://console.anthropic.com/) (configured in Settings within the app)

## Features

### Annotation Workflow
- **Grid overview** of all files with directory browsing
- **Gallery mode** for focused annotation — large preview + sidebar with comments
- **Voice input** with live transcription (Web Speech API) and audio recording saved alongside comments
- **Punctuation heuristics** that clean up speech-to-text output (capitalization, sentence breaks, proper nouns)
- **Region annotations** — draw rectangles on images to annotate specific areas; coordinates stored as percentages
- **Ask Claude** button on any file — sends the image + existing comments to Claude for AI analysis
- **Ask Claude on regions** — draw a region and ask Claude to describe just that area (cropped server-side with sharp for accuracy)
- **Auto-annotate** — Claude identifies regions in an image and creates annotated comments for each
- **Keyboard shortcuts** for fast navigation: arrow keys, `/` to focus comment input, `R` to record, `Esc` to return to grid

### Subdirectory Navigation
- **Browse into subdirectories** — folders appear as grid items at the top of the file grid
- **Breadcrumb bar** — clickable path segments for navigating up through the directory hierarchy
- **Backspace** navigates to the parent directory from grid view
- **URL hash routing** — directory state persists across browser back/forward
- **Per-directory data** — each subdirectory has its own `.context.json`, `SUMMARY.md`, thumbnails, and audio

### Chat
- **Persistent chat panel** on the right side with localStorage-backed session history
- **Search-first architecture** — Claude uses FTS5 full-text search to find relevant content across all directories instead of loading everything upfront
- **Multi-turn tool use** — Claude can search, reason, and refine across up to 6 rounds per message
- **File attachments** — attach full images or cropped annotation regions to messages
- **Voice input** — mic button for speech-to-text in both file chat and folder chat
- **Smart file cards** — Claude responds with visual file collections (thumbnails, descriptions, zip download)
- **Copy chat** — copy all file comments as a markdown transcript from the copy dropdown
- **Right-click "Send to Chat"** on grid items, comments, and region overlays
- **Drag-to-chat** — drag images from the grid into the chat panel, or drop external files
- **File picker** shows annotation crops alongside full images for selection

### Summary Generation
- **Multimodal summaries** — includes thumbnails from `.thumbs/` for visual context alongside annotations
- **Per-directory summaries** scoped to the files in the current folder
- **Aggregate summaries** — generate a root-level summary that spans all subdirectories recursively
- **Clickable citations** — every summary bullet links back to the specific comment it references; clicking navigates to that comment with a highlight flash
- **Image references** — file names in the summary are clickable and open that image in gallery view
- **Version history** — each generation creates a new version (`v1`, `v2`, ...) stored in `.summary-history/`; flip through older versions with prev/next arrows
- **Edit mode** — manually edit the rendered summary markdown in-place
- **Copy to clipboard** — one-click copy of the raw markdown

### File Resilience (Move/Rename Protection)
- **Content fingerprinting** — SHA-256 of the first 64KB of each annotated file, stored in `.context.json`
- **Auto-reconciliation** — on startup, orphaned annotations are automatically matched to moved/renamed files by content hash
- **Real-time watcher** — rename/move events detected live while the server runs
- **Alias tracking** — SQLite `file_aliases` table maps old→new paths; chains are flattened (A→B then B→C becomes A→C)
- **Audio file migration** — `.audio_*` files are renamed alongside their parent file
- **Comment attachment updates** — cross-references in other files' comments are updated when a file moves
- **In-app rename** — rename button in the file detail sidebar header
- **Resilient chat links** — old file references in chat resolve via the alias table

### Export
- **ML export** — consolidated export to JSONL + COCO detection format with deterministic filenames
- Produces `crops/`, `originals/`, `annotations.jsonl`, and `coco.json`
- Filter by author (all, user, claude) and scope (file, directory, root)

### SQLite Index
- **FTS5 full-text search** — all text files and annotations indexed for instant search across the project
- **File watcher** — live re-indexing when files change on disk
- **Index status indicator** — database icon in topbar shows indexing state (green/yellow/gray)
- **Reindex button** — full rebuild from the index stats panel

### Architecture
- **Single HTML file** frontend — no build step, no framework, vanilla JS with [Phosphor Icons](https://phosphoricons.com/) and marked.js for markdown rendering
- **Bun server** (`server.ts`) — serves the app, handles file I/O, proxies Anthropic API calls
- **SQLite indexer** (`indexer.ts`) — FTS5 search index via `bun:sqlite`, file watcher, alias tracking
- **Region cropping** — server-side image cropping with [sharp](https://sharp.pixelplumbing.com/) for accurate Claude analysis
- **Sidecar data** — all annotations stored in `.context.json` next to your files, summaries in `SUMMARY.md` and `.summary-history/`
- **Auto-refresh polling** — if you edit `.context.json` externally, the UI picks up changes within 2 seconds
- **API key stored locally** in `.annotator-settings.json` (gitignored)

## Supported File Types

| Type | Extensions | Preview |
|------|-----------|---------|
| Images | `.jpg` `.jpeg` `.png` `.gif` `.webp` `.heic` `.heif` `.svg` | Inline image |
| PDFs | `.pdf` | Embedded iframe |
| Documents | `.txt` `.md` `.doc` `.docx` | Icon placeholder |

## Project Structure

```
context-annotator/
  server.ts          # Bun HTTP server (API + static serving)
  indexer.ts         # SQLite FTS5 indexer + file watcher
  public/
    index.html       # Single-page frontend (CSS + JS + HTML)
  package.json
  tsconfig.json
```

## Data Files (created in your session folder)

Each directory is self-contained:

```
your-session-folder/
  .context.json            # Annotations for files in this directory
  .conan.db                # SQLite index (FTS5 search, file aliases)
  .summary-history/        # Versioned summaries (v1.md, v2.md, ...)
  .thumbs/                 # Cached thumbnails
  .audio_*.ogg/.webm       # Voice recording files
  SUMMARY.md               # Latest generated summary
  subfolder/
    .context.json          # Annotations for this subfolder's files
    .summary-history/
    .thumbs/
    SUMMARY.md
```

## API Endpoints

### Files & Directories

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/files?dir=subdir` | List files + subdirectories for a directory |
| `GET` | `/api/tree` | Recursive directory tree (cached 5s TTL) |
| `GET` | `/api/files/:path/preview` | Serve file content |
| `GET` | `/api/files/:path/thumb` | Serve thumbnail |
| `PATCH` | `/api/files/:path/status` | Update file status |

`:path` is the relative path from root, URL-encoded (slashes become `%2F`).

### Comments

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/files/:path/comments` | Add a comment |
| `DELETE` | `/api/files/:path/comments/:index` | Delete a comment |
| `PUT` | `/api/files/:path/comments/:index/text` | Update comment text |
| `PUT` | `/api/files/:path/comments/:index/region` | Update comment region |
| `POST` | `/api/files/:path/comments/:index/fix` | Fix formatting with Claude |

### Claude Analysis

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/files/:path/ask-claude` | AI analysis of a file |
| `POST` | `/api/files/:path/describe-region` | AI description of a drawn region |
| `POST` | `/api/files/:path/auto-annotate` | AI region detection + annotation |

### Summary

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/summary?dir=subdir` | Get current summary |
| `POST` | `/api/summary?dir=subdir` | Save edited summary |
| `POST` | `/api/summary/generate?dir=subdir&aggregate=true` | Generate summary (add `aggregate=true` for all subdirs) |
| `GET` | `/api/summary/versions?dir=subdir` | List all summary versions |
| `GET` | `/api/summary/versions/:n?dir=subdir` | Get specific version |

### File Move Handling

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/orphans?dir=subdir` | List orphaned annotations |
| `POST` | `/api/orphans/clean?dir=subdir` | Remove orphaned annotations |
| `POST` | `/api/reconcile` | Match + migrate orphaned annotations by content hash |
| `GET` | `/api/index/find-file?q=name` | Resolve old filenames via alias table |

### SQLite Index

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/index/stats` | Index stats (files, chunks, annotations) |
| `POST` | `/api/index/reindex` | Full rebuild of the search index |
| `POST` | `/api/index/search` | Full-text search across all indexed content |

### Export

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/export` | Export annotated regions as zip (crops, originals, JSONL, COCO) |

### Chat

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/chat` | Send a message to Claude with file/region attachments |
| `POST` | `/api/download-files` | Download a set of files as a zip |

### Media

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/files/:path/crop` | Serve a cropped region of an image |
| `GET` | `/api/files/:path/audio` | Upload audio for a file |
| `GET` | `/api/audio/:path` | Serve an audio file |

### Other

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config` | Server config (folder path, API key status) |
| `GET/POST` | `/api/settings` | Read/write API key |

## License

Private
