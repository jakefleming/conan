# Production Readiness Audit

**Date:** 2026-03-17
**Codebase:** Context Annotator (Conan)
**Server:** `server.ts` (1,981 lines) | **Frontend:** `public/index.html` (5,255 lines)
**Runtime:** Bun + TypeScript | **Dependencies:** sharp, jszip

---

## Critical Findings

| Issue | Severity | Location | Description |
|-------|----------|----------|-------------|
| No authentication | **CRITICAL** | All endpoints | Zero auth — anyone on the network can read/write annotations, change the API key, and call Claude |
| No rate limiting | **HIGH** | All endpoints | No per-IP or per-endpoint throttling; Claude API calls (`/ask-claude`, `/chat`, `/auto-annotate`, `/summary/generate`) could burn through Anthropic credits |
| No file upload size limits | **HIGH** | Audio upload, chat attachments | Entire request body buffered in memory — large uploads can exhaust memory |
| API key in plaintext | **HIGH** | `.annotator-settings.json` | Stored as plain JSON on disk; `POST /api/settings` accepts any key without validation |
| No input validation library | **MEDIUM** | All POST/PUT endpoints | Request bodies cast with `as` — no runtime schema validation (e.g., Zod) |
| External CDN scripts without SRI | **MEDIUM** | `public/index.html` | Phosphor Icons and marked.js loaded from unpkg/jsdelivr without integrity hashes |
| No structured logging | **MEDIUM** | Everywhere | Only two `console.log` calls at startup; no request logging, no error logging to files |
| No concurrent access control | **MEDIUM** | `.context.json` writes | Two simultaneous writes will clobber each other — no file locking |

---

## What's Working Well

- **Path traversal protection** — `safePath()` (server.ts:38-44) uses `normalize()` + prefix check consistently across all file-serving endpoints
- **Region coordinate validation** — bounds checking and clamping to 0-100% range
- **Comment author sanitization** — forced to `"user"` or `"claude"` enum
- **Empty comment rejection** — `text.trim()` check before accepting
- **API image size cap** — `MAX_API_IMAGE_BYTES = 3,750,000` with automatic downscaling via sharp
- **Per-file dedup guards** — `pendingAskClaude` and `pendingAutoAnnotate` Sets prevent concurrent Claude calls on the same file
- **Thumbnail caching** — `.thumbs/` with `Cache-Control: max-age=86400`
- **Minimal dependency surface** — only 2 production deps (sharp, jszip)
- **`.gitignore` coverage** — settings file, thumbs, and audio files excluded

---

## Detailed Assessment

### 1. Authentication & Authorization

**Status:** Not implemented

No auth on any endpoint. Key risks:
- `POST /api/settings` — anyone can overwrite the Anthropic API key (server.ts:975-978)
- `DELETE /api/files/:path/comments/:index` — anyone can delete annotations
- `POST /api/chat` — anyone can make Claude API calls on your dime

**Recommendation:** Add at minimum a bearer token or basic auth. For local-only use, bind to `127.0.0.1` instead of `0.0.0.0`.

### 2. Input Validation

**Status:** Partial — ad-hoc checks, no schema validation

Good:
- Empty comment text rejected
- Author field coerced to enum
- Region coordinates type-checked (`typeof region.x !== "number"`)

Missing:
- No max length on comment text
- No validation on chat message payloads
- No validation on export request body
- All `req.json()` calls use type assertions (`as`) instead of runtime validation

**Recommendation:** Add Zod schemas for all request bodies.

### 3. Error Handling

**Status:** Inconsistent

- Most endpoints wrapped in try-catch returning `json({ error }, 400|500)`
- Some catch blocks are empty/silent (server.ts:186, 577, 648)
- No global error handler on `Bun.serve()` — an uncaught exception in the fetch handler crashes the process
- No error tracking service (Sentry, etc.)

**Recommendation:** Add a top-level try-catch in the fetch handler. Add structured error logging.

### 4. API Key Management

**Status:** Plaintext file, no rotation

- Stored in `.annotator-settings.json` as `{ "apiKey": "sk-ant-..." }`
- Read on every Claude API call
- Settings GET endpoint doesn't leak the key (returns `hasApiKey: boolean` only) — good
- Settings POST accepts any string without format validation

**Recommendation:** Use environment variables (`ANTHROPIC_API_KEY`). Never write the key to disk in production. Add `sk-ant-` prefix validation if accepting via UI.

### 5. CORS & Network Security

**Status:** Minimal

- `Access-Control-Allow-Origin: *` set only on file preview endpoint (server.ts:1322)
- No explicit CORS on other endpoints (relies on browser same-origin policy)
- Server binds to all interfaces by default
- No HTTPS — relies on being localhost

**Recommendation:** Add explicit CORS whitelist. Bind to `127.0.0.1` for local use. Add HTTPS termination for any network deployment.

### 6. File & Media Handling

**Status:** Secure paths, no content validation

- `safePath()` prevents directory traversal — consistently applied
- MIME types determined by file extension, not content (magic bytes)
- No file size limits on uploads
- sharp operations could be memory-intensive on very large images
- Thumbnails and crops cached with appropriate `Cache-Control` headers

**Recommendation:** Add `file-type` library for magic byte validation. Add request body size limits. Consider streaming for large files.

### 7. Data Persistence

**Status:** JSON files, no locking

- `.context.json` per directory — read-modify-write cycle with no atomicity
- Two concurrent requests modifying the same file will lose one write
- No backup/recovery mechanism beyond summary version history
- No data integrity checks (checksums, signatures)

**Recommendation:** Migrate to SQLite (`bun:sqlite`) for atomic writes and concurrent access. Or add file-level locking with `proper-lockfile`.

### 8. Testing

**Status:** None

- No test files found (no `*.test.ts`, `*.spec.ts`, `__tests__/`)
- No test framework configured
- No CI/CD pipeline

**Recommendation:** Add tests using Bun's built-in test runner. Priority targets:
1. `safePath()` with adversarial inputs
2. API endpoint integration tests (comment CRUD, status updates)
3. Region coordinate validation edge cases
4. JSON parsing error recovery

### 9. Logging & Observability

**Status:** Minimal

- Two `console.log` calls at startup (port, folder path)
- No request logging (method, path, status, duration)
- No error logging with stack traces
- No audit trail for who changed what

**Recommendation:** Add structured JSON logging (e.g., `pino`). Log all requests and errors. Add request IDs for tracing.

### 10. Deployment & Operations

**Status:** Not configured

Missing:
- Dockerfile / docker-compose
- Health check endpoint (`GET /api/health`)
- Graceful shutdown (SIGTERM/SIGINT handling)
- Process manager configuration (systemd, pm2)
- Environment-based configuration (port, log level, etc.)

Present:
- `bun run server.ts /path` startup
- Hardcoded port 3333

**Recommendation:** Add Dockerfile, health endpoint, signal handlers, and environment variable support.

### 11. Frontend Security

**Status:** Acceptable with caveats

- No framework XSS protections (vanilla JS with direct DOM manipulation)
- Comments rendered via `marked.js` (markdown) — potential XSS if not sanitized
- External scripts loaded without Subresource Integrity (SRI) hashes
- No Content Security Policy (CSP) headers

**Recommendation:** Add SRI hashes to CDN script tags. Add CSP headers from the server. Verify marked.js sanitization settings.

### 12. Performance & Scalability

**Status:** Adequate for small datasets

- Tree cache with 5s TTL — good
- Thumbnail caching on disk — good
- No connection pooling for Anthropic API calls
- Full file reads into memory (no streaming)
- Single-threaded Bun server — no worker threads for image processing

**Recommendation:** Add streaming for large file operations. Consider worker threads for sharp operations. Monitor memory usage under load.

---

## Prioritized Action Items

### Immediate (before any network exposure)
1. Bind server to `127.0.0.1`
2. Add authentication (bearer token or basic auth)
3. Add request body size limits
4. Add global error handler in fetch

### Short-term
5. Add Zod validation for all request bodies
6. Implement structured logging
7. Support `ANTHROPIC_API_KEY` environment variable
8. Add SRI hashes for CDN scripts
9. Add health check endpoint
10. Add graceful shutdown handlers

### Medium-term
11. Add test suite (Bun test runner)
12. Migrate `.context.json` to SQLite
13. Add rate limiting on Claude API endpoints
14. Add Dockerfile
15. Add CSP headers

### Long-term
16. Split `index.html` into components with a build step (Vite)
17. Add OpenAPI documentation
18. Add monitoring and alerting
19. Add CI/CD pipeline with automated tests
