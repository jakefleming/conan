# Context Annotator (Conan)

A Bun-powered local tool for annotating images/sketches from design sessions with voice + text comments and Claude analysis.

**Important:** When working with a target folder, always check for a `CLAUDE.md` in that folder for project-specific context (e.g. what the images are about, domain knowledge, how annotations should be written).

## Running the server

```bash
bun run server.ts /path/to/folder
```

Server runs on `http://localhost:3333`. The target folder should contain images (jpg, jpeg, png, gif, webp). Subdirectories are supported — the UI provides breadcrumb navigation to browse into them.

## Data format

Each directory has its own `.context.json` containing annotations for files in that directory. Keys are bare filenames (not paths). Structure:

```json
{
  "filename.jpeg": {
    "hash": "a1b2c3d4e5f6g7h8",
    "comments": [
      {
        "author": "user" | "claude",
        "text": "comment text",
        "ts": "2026-03-13T17:14:41.154Z",
        "audio": ".audio_filename_timestamp.ogg",
        "region": { "x": 10, "y": 20, "w": 30, "h": 40 }
      }
    ],
    "status": "pending" | "annotated" | "skipped"
  }
}
```

- `hash` (optional): SHA-256 of first 64KB, truncated to 16 hex chars. Used for detecting moved/renamed files. Computed lazily on first annotation.
- `audio` (optional): Relative path to audio file stored in the same directory as the image.
- `region` (optional): Percentage-based coordinates (x, y, w, h) of image dimensions.

## Directory structure

Each subdirectory is self-contained with its own:
- `.context.json` — annotations for files in that directory
- `SUMMARY.md` — generated or manually written summary
- `.summary-history/` — versioned summary snapshots
- `.thumbs/` — cached thumbnails

## API endpoints (all relative to localhost:3333)

### Files & Directories
- `GET /api/files?dir=subdir` — List files + subdirectories for a directory. Returns mixed array of `{type:"directory",...}` and `{type:"file",...}` entries. Omit `?dir=` for root.
- `GET /api/tree` — Recursive directory tree (cached 5s TTL)
- `GET /api/files/:path/preview` — Serve the original file
- `GET /api/files/:path/thumb` — Serve a thumbnail
- `PATCH /api/files/:path/status` — Update status. Body: `{ status: "pending"|"annotated"|"skipped" }`

`:path` is the relative path from root, URL-encoded (slashes become `%2F`). For root files, it's just the filename.

### Comments
- `POST /api/files/:path/comments` — Add comment. Body: `{ author: "user"|"claude", text: "...", region?: {x,y,w,h} }`
- `DELETE /api/files/:path/comments/:index` — Delete comment by index
- `PUT /api/files/:path/comments/:index/text` — Update comment text. Body: `{ text: "..." }`
- `PUT /api/files/:path/comments/:index/region` — Update comment region. Body: `{ region: {x,y,w,h} }`
- `POST /api/files/:path/comments/:index/fix` — Fix formatting with Claude (no body needed)

### Claude analysis
- `POST /api/files/:path/ask-claude` — Claude analyzes the image + existing comments, adds a claude comment
- `POST /api/files/:path/auto-annotate` — Claude identifies regions in the image and creates region-annotated comments

### Summary
- `GET /api/summary?dir=subdir` — Get summary for a directory
- `POST /api/summary?dir=subdir` — Manually save summary text. Body: `{ content: "..." }`
- `POST /api/summary/generate?dir=subdir&aggregate=true` — Generate summary with Claude. Add `&aggregate=true` to include all subdirectories recursively.
- `GET /api/summary/versions?dir=subdir` — List summary versions
- `GET /api/summary/versions/:n?dir=subdir` — Get specific version

### File move handling
- `GET /api/orphans?dir=subdir` — List annotations in `.context.json` that don't match any file on disk
- `POST /api/reconcile` — Scan entire tree, match orphaned annotations to moved files by content hash, migrate automatically

### Other
- `GET /api/config` — Get config (hasApiKey, folder path)
- `GET/POST /api/settings` — Get or update settings (apiKey)

## Adding comments without the UI

You can directly edit `.context.json` in the target folder, or use curl:

```bash
# Add a user comment (root file)
curl -X POST http://localhost:3333/api/files/IMG_5210.jpeg/comments \
  -H "Content-Type: application/json" \
  -d '{"author":"user","text":"My comment here"}'

# Add a comment to a file in a subdirectory (encode / as %2F)
curl -X POST http://localhost:3333/api/files/session-1%2FIMG_5210.jpeg/comments \
  -H "Content-Type: application/json" \
  -d '{"author":"user","text":"My comment here"}'

# Add a comment with a region annotation (x,y,w,h are percentages of image dimensions)
curl -X POST http://localhost:3333/api/files/IMG_5210.jpeg/comments \
  -H "Content-Type: application/json" \
  -d '{"author":"user","text":"This area shows the nav","region":{"x":10,"y":5,"w":40,"h":20}}'

# Ask Claude to analyze a file
curl -X POST http://localhost:3333/api/files/IMG_5210.jpeg/ask-claude

# Fix a comment's formatting (index 0)
curl -X POST http://localhost:3333/api/files/IMG_5210.jpeg/comments/0/fix

# Update comment text
curl -X PUT http://localhost:3333/api/files/IMG_5210.jpeg/comments/0/text \
  -H "Content-Type: application/json" \
  -d '{"text":"Updated text here"}'

# Delete a comment (index 1)
curl -X DELETE http://localhost:3333/api/files/IMG_5210.jpeg/comments/1

# Generate aggregate summary across all subdirectories
curl -X POST "http://localhost:3333/api/summary/generate?aggregate=true"
```

Or edit `.context.json` directly — the UI will pick up changes on next load.

## Tech stack
- **Server:** Bun + TypeScript (`server.ts`)
- **Frontend:** Single HTML file with vanilla JS (`public/index.html`)
- **Canvas:** SVG overlay sharing CSS transform with image for zoom/pan/rotation
- **Annotations:** Region coordinates stored as percentages (x, y, w, h) of image dimensions
- **File identity:** Content hashing (SHA-256 of first 64KB) for detecting moved/renamed files
