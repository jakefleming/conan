# Conan - Context Annotator

A local-first tool for capturing and synthesizing context from in-person product and design sessions. Point it at a folder of photos, sketches, or documents, then walk through each one adding voice or text annotations. When you're done, generate an AI-powered summary that links back to every source comment and image.

## Quick Start

```bash
bun run server.ts /path/to/your/session-folder
```

Then open [http://localhost:3333](http://localhost:3333).

Your session folder should contain the images, PDFs, or documents you want to annotate. Conan creates a `.context.json` sidecar file in that folder to store all annotations.

## Requirements

- [Bun](https://bun.sh) runtime
- An [Anthropic API key](https://console.anthropic.com/) (configured in Settings within the app)

## Features

### Annotation Workflow
- **Grid overview** with filter tabs (All / Pending / Annotated / Skipped) for quick triage
- **Gallery mode** for focused annotation -- large preview + sidebar with comments
- **Voice input** with live transcription (Web Speech API) and audio recording saved alongside comments
- **Punctuation heuristics** that clean up speech-to-text output (capitalization, sentence breaks, proper nouns)
- **Ask Claude** button on any file -- sends the image + existing comments to Claude for AI analysis that adds implementation notes without repeating what you already said
- **Keyboard shortcuts** for fast navigation: arrow keys, `/` to focus comment input, `R` to record, `S` to skip, `Esc` to return to grid

### Summary Generation
- **Combined summary** with executive overview at the top and design deliverables at the bottom, generated in a single pass
- **Clickable citations** -- every summary bullet links back to the specific comment it references; clicking navigates to that comment with a highlight flash
- **Image references** -- file names in the summary are clickable and open that image in gallery view
- **Version history** -- each generation creates a new version (`v1`, `v2`, ...) stored in `.summary-history/`; flip through older versions with prev/next arrows
- **Edit mode** -- manually edit the rendered summary markdown in-place
- **Copy to clipboard** -- one-click copy of the raw markdown

### Architecture
- **Single HTML file** frontend -- no build step, no framework, vanilla JS with marked.js for markdown rendering
- **Bun server** (`server.ts`) -- serves the app, handles file I/O, proxies Anthropic API calls
- **Sidecar data** -- all annotations stored in `.context.json` next to your files, summaries in `SUMMARY.md` and `.summary-history/`
- **Auto-refresh polling** -- if you edit `.context.json` externally, the UI picks up changes within 2 seconds
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
  public/
    index.html       # Single-page frontend (CSS + JS + HTML)
  package.json
  tsconfig.json
```

## Data Files (created in your session folder)

```
your-session-folder/
  .context.json            # All annotations (comments, statuses, timestamps)
  .summary-history/        # Versioned summaries (v1.md, v2.md, ...)
  .audio_*.ogg/.webm       # Voice recording files
  SUMMARY.md               # Latest generated summary
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config` | Server config (folder path, API key status) |
| `GET/POST` | `/api/settings` | Read/write API key |
| `GET` | `/api/files` | List files with annotation status |
| `GET` | `/api/files/:name/preview` | Serve file content |
| `POST` | `/api/files/:name/comments` | Add a comment |
| `DELETE` | `/api/files/:name/comments/:index` | Delete a comment |
| `PATCH` | `/api/files/:name/status` | Update file status |
| `POST` | `/api/files/:name/ask-claude` | AI analysis of a file |
| `POST` | `/api/files/:name/audio` | Upload voice recording |
| `GET` | `/api/audio/:name` | Serve audio file |
| `GET` | `/api/summary` | Get current summary |
| `POST` | `/api/summary` | Save edited summary |
| `POST` | `/api/summary/generate` | Generate new summary version |
| `GET` | `/api/summary/versions` | List all summary versions |
| `GET` | `/api/summary/versions/:n` | Get specific version |

## License

Private
