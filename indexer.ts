/**
 * Conan Indexer — SQLite-backed index for fast retrieval across large file collections.
 *
 * The index is a read-optimized layer. Files + .context.json remain the source of truth.
 * The DB can always be rebuilt from disk.
 */

import { Database } from "bun:sqlite";
import { readdir, readFile, stat, watch } from "fs/promises";
import { join, extname, basename, dirname } from "path";
import { existsSync } from "fs";
import { createHash } from "crypto";

const HIDDEN_DIRS = new Set([".thumbs", ".summary-history", ".git", ".DS_Store", ".attachments", "node_modules", "__pycache__", ".venv", "venv", ".next", "dist", "build"]);
const CONTEXT_FILE = ".context.json";
const SUMMARY_FILE = "SUMMARY.md";
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".csv", ".tsv", ".xml", ".yaml", ".yml",
  ".toml", ".ini", ".log", ".html", ".css", ".js", ".ts", ".py",
  ".rb", ".sh", ".sql", ".rtf",
]);
const INDEXABLE_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ".pdf", ".doc", ".docx",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".svg",
]);
const MAX_TEXT_SIZE = 100_000; // 100KB per file for indexing

// ── Schema ──

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  dir TEXT NOT NULL,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  size INTEGER,
  modified_at TEXT,
  indexed_at TEXT,
  content_hash TEXT,
  file_type TEXT
);

CREATE TABLE IF NOT EXISTS file_aliases (
  id INTEGER PRIMARY KEY,
  old_path TEXT NOT NULL,
  new_path TEXT NOT NULL,
  renamed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aliases_old ON file_aliases(old_path);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  chunk_type TEXT NOT NULL,
  content TEXT NOT NULL,
  people TEXT,
  date_ref TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY,
  file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  comment_index INTEGER,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  region_json TEXT,
  attachments_json TEXT,
  created_at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  people,
  content='chunks',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS annotations_fts USING fts5(
  text,
  content='annotations',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content, people) VALUES (new.id, new.content, new.people);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, people) VALUES('delete', old.id, old.content, old.people);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, people) VALUES('delete', old.id, old.content, old.people);
  INSERT INTO chunks_fts(rowid, content, people) VALUES (new.id, new.content, new.people);
END;

CREATE TRIGGER IF NOT EXISTS annotations_ai AFTER INSERT ON annotations BEGIN
  INSERT INTO annotations_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS annotations_ad AFTER DELETE ON annotations BEGIN
  INSERT INTO annotations_fts(annotations_fts, rowid, text) VALUES('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS annotations_au AFTER UPDATE ON annotations BEGIN
  INSERT INTO annotations_fts(annotations_fts, rowid, text) VALUES('delete', old.id, old.text);
  INSERT INTO annotations_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

// ── Types ──

export interface IndexStats {
  totalFiles: number;
  totalChunks: number;
  totalAnnotations: number;
  lastIndexed: string | null;
  indexing: boolean;
  pendingExtraction: number;
}

export interface SearchResult {
  fileId: number;
  filePath: string;
  fileName: string;
  fileType: string;
  chunkType: string;
  content: string;
  people: string | null;
  dateRef: string | null;
  rank: number;
}

export interface SearchFilters {
  people?: string[];
  chunk_type?: string[];
  date_from?: string;
  date_to?: string;
  directory?: string;
  file_type?: string;
}

// ── Indexer Class ──

export class ConanIndexer {
  public db: Database;
  private projectRoot: string;
  private watcher: any = null;
  private indexing = false;
  private debounceTimer: any = null;
  private pendingPaths = new Set<string>();
  private apiKey: string | null = null;
  private extractionQueue: string[] = [];
  private extracting = false;
  // Phase 3: Real-time move detection
  private recentlyDeleted = new Map<string, { path: string; hash: string; timestamp: number }>();
  private cleanupInterval: any = null;
  onFileMoved: ((oldPath: string, newPath: string, hash: string) => Promise<void>) | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    const dbPath = join(projectRoot, ".conan.db");
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  /** Switch to a new project root (called when user changes folder) */
  switchProject(projectRoot: string) {
    this.stopWatcher();
    this.db.close();
    this.projectRoot = projectRoot;
    const dbPath = join(projectRoot, ".conan.db");
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  setApiKey(key: string | null) {
    this.apiKey = key;
  }

  /** Rename a file in the index (used when user renames via UI) */
  renameFile(oldPath: string, newPath: string) {
    const name = basename(newPath);
    const dir = dirname(newPath) === "." ? "" : dirname(newPath);
    const ext = extname(newPath).toLowerCase();
    this.db.run(
      "UPDATE files SET path=?, dir=?, name=?, ext=? WHERE path=?",
      [newPath, dir, name, ext, oldPath]
    );
  }

  /** Get the stored content hash for a file path (from SQLite) */
  getStoredHash(relPath: string): string | null {
    const row = this.db.query("SELECT content_hash FROM files WHERE path = ?").get(relPath) as { content_hash: string } | null;
    return row?.content_hash ?? null;
  }

  /** Look up a file path by its content hash */
  findByHash(hash: string): string | null {
    const row = this.db.query("SELECT path FROM files WHERE content_hash = ?").get(hash) as { path: string } | null;
    return row?.path ?? null;
  }

  // ── Full Scan ──

  /** Scan the entire project and index new/changed files */
  async fullScan(): Promise<{ indexed: number; skipped: number; removed: number }> {
    if (this.indexing) return { indexed: 0, skipped: 0, removed: 0 };
    this.indexing = true;
    let indexed = 0, skipped = 0;

    try {
      const allFiles = await this.walkDir(this.projectRoot, "");
      const existingPaths = new Set(allFiles.map(f => f.path));

      // Remove files that no longer exist
      const dbFiles = this.db.query("SELECT id, path FROM files").all() as { id: number; path: string }[];
      const removed = dbFiles.filter(f => !existingPaths.has(f.path));
      for (const f of removed) {
        this.db.run("DELETE FROM files WHERE id = ?", [f.id]);
      }

      // Index each file
      for (const file of allFiles) {
        const result = await this.indexFile(file.path, file.absPath);
        if (result === "indexed") indexed++;
        else skipped++;
      }

      // Sync all annotations
      await this.syncAllAnnotations();

      return { indexed, skipped, removed: removed.length };
    } finally {
      this.indexing = false;
    }
  }

  /** Walk directory recursively, return all indexable files */
  private async walkDir(absDir: string, relPath: string): Promise<{ path: string; absPath: string }[]> {
    const results: { path: string; absPath: string }[] = [];
    try {
      const entries = await readdir(absDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || HIDDEN_DIRS.has(entry.name)) continue;
        if (entry.name === CONTEXT_FILE || entry.name === SUMMARY_FILE) continue;
        const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
        const childAbs = join(absDir, entry.name);
        if (entry.isDirectory()) {
          results.push(...await this.walkDir(childAbs, childRel));
        } else {
          const ext = extname(entry.name).toLowerCase();
          if (INDEXABLE_EXTENSIONS.has(ext)) {
            results.push({ path: childRel, absPath: childAbs });
          }
        }
      }
    } catch {}
    return results;
  }

  /** Index a single file. Returns "indexed" or "skipped" */
  private async indexFile(relPath: string, absPath: string): Promise<"indexed" | "skipped"> {
    const ext = extname(relPath).toLowerCase();
    const name = basename(relPath);
    const dir = dirname(relPath) === "." ? "" : dirname(relPath);

    // Get file stats
    let fileStat;
    try { fileStat = await stat(absPath); } catch { return "skipped"; }

    const modifiedAt = fileStat.mtime.toISOString();
    const size = fileStat.size;

    // Compute content hash (first 64KB)
    let contentHash = "";
    try {
      const buf = Buffer.alloc(65536);
      const file = Bun.file(absPath);
      const slice = file.slice(0, 65536);
      const data = await slice.arrayBuffer();
      contentHash = createHash("sha256").update(Buffer.from(data)).digest("hex").slice(0, 16);
    } catch {}

    // Check if already indexed with same hash
    const existing = this.db.query("SELECT id, content_hash FROM files WHERE path = ?").get(relPath) as { id: number; content_hash: string } | null;
    if (existing && existing.content_hash === contentHash) {
      return "skipped";
    }

    // Determine file type
    let fileType = "other";
    if (TEXT_EXTENSIONS.has(ext)) fileType = "text";
    else if (ext === ".pdf") fileType = "pdf";
    else if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".svg"].includes(ext)) fileType = "image";

    // Upsert file record
    if (existing) {
      this.db.run(
        "UPDATE files SET dir=?, name=?, ext=?, size=?, modified_at=?, indexed_at=?, content_hash=?, file_type=? WHERE id=?",
        [dir, name, ext, size, modifiedAt, new Date().toISOString(), contentHash, fileType, existing.id]
      );
      // Clear old chunks for re-indexing
      this.db.run("DELETE FROM chunks WHERE file_id = ?", [existing.id]);
    } else {
      this.db.run(
        "INSERT INTO files (path, dir, name, ext, size, modified_at, indexed_at, content_hash, file_type) VALUES (?,?,?,?,?,?,?,?,?)",
        [relPath, dir, name, ext, size, modifiedAt, new Date().toISOString(), contentHash, fileType]
      );
    }

    const fileId = (this.db.query("SELECT id FROM files WHERE path = ?").get(relPath) as { id: number }).id;

    // Extract and store text content as a full_text chunk
    if (fileType === "text") {
      try {
        const content = await readFile(absPath, "utf-8");
        const trimmed = content.slice(0, MAX_TEXT_SIZE);
        this.db.run(
          "INSERT INTO chunks (file_id, chunk_type, content, created_at) VALUES (?,?,?,?)",
          [fileId, "full_text", trimmed, new Date().toISOString()]
        );
      } catch {}
    }

    // Queue for Claude extraction (text and pdf files)
    if ((fileType === "text" || fileType === "pdf") && !this.extractionQueue.includes(relPath)) {
      this.extractionQueue.push(relPath);
    }

    return "indexed";
  }

  // ── Annotation Sync ──

  /** Sync all .context.json files into the annotations table */
  private async syncAllAnnotations() {
    await this.syncAnnotationsForDir(this.projectRoot, "");
  }

  private async syncAnnotationsForDir(absDir: string, relPath: string) {
    try {
      const contextPath = join(absDir, CONTEXT_FILE);
      if (existsSync(contextPath)) {
        const raw = await readFile(contextPath, "utf-8");
        const context = JSON.parse(raw);
        for (const [filename, fileCtx] of Object.entries(context) as [string, any][]) {
          const filePath = relPath ? `${relPath}/${filename}` : filename;
          const fileRow = this.db.query("SELECT id FROM files WHERE path = ?").get(filePath) as { id: number } | null;
          if (!fileRow) continue;

          // Clear existing annotations for this file
          this.db.run("DELETE FROM annotations WHERE file_id = ?", [fileRow.id]);

          // Insert current annotations
          if (fileCtx.comments) {
            for (let i = 0; i < fileCtx.comments.length; i++) {
              const c = fileCtx.comments[i];
              this.db.run(
                "INSERT INTO annotations (file_id, comment_index, author, text, region_json, attachments_json, created_at) VALUES (?,?,?,?,?,?,?)",
                [
                  fileRow.id, i, c.author, c.text,
                  c.region ? JSON.stringify(c.region) : null,
                  c.attachments ? JSON.stringify(c.attachments) : null,
                  c.ts || new Date().toISOString(),
                ]
              );
            }
          }
        }
      }

      // Recurse into subdirectories
      const entries = await readdir(absDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || HIDDEN_DIRS.has(entry.name)) continue;
        const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
        await this.syncAnnotationsForDir(join(absDir, entry.name), childRel);
      }
    } catch {}
  }

  // ── File Watcher ──

  startWatcher() {
    if (this.watcher) return;
    try {
      const fsWatch = require("fs").watch;
      this.watcher = fsWatch(this.projectRoot, { recursive: true }, (eventType: string, filename: string) => {
        if (!filename) return;
        // Skip hidden dirs and non-indexable files
        const parts = filename.split("/");
        if (parts.some((p: string) => p.startsWith(".") || HIDDEN_DIRS.has(p))) {
          // But DO process .context.json changes
          if (!filename.endsWith(CONTEXT_FILE)) return;
        }

        this.pendingPaths.add(filename);
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.processPending(), 1000);
      });
      // Cleanup stale entries from recentlyDeleted every 5 seconds
      this.cleanupInterval = setInterval(() => {
        const cutoff = Date.now() - 5000;
        for (const [hash, info] of this.recentlyDeleted) {
          if (info.timestamp < cutoff) this.recentlyDeleted.delete(hash);
        }
      }, 5000);
      console.log("Index watcher started");
    } catch (e) {
      console.error("Failed to start file watcher:", e);
    }
  }

  stopWatcher() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.recentlyDeleted.clear();
  }

  private async processPending() {
    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();

    const deletedPaths: string[] = [];
    const createdPaths: string[] = [];

    // First pass: categorize events
    for (const p of paths) {
      if (p.endsWith(CONTEXT_FILE)) {
        const dir = dirname(p) === "." ? "" : dirname(p);
        await this.syncAnnotationsForDir(join(this.projectRoot, dir), dir);
      } else {
        const absPath = join(this.projectRoot, p);
        const ext = extname(p).toLowerCase();
        if (!INDEXABLE_EXTENSIONS.has(ext)) continue;
        if (existsSync(absPath)) {
          createdPaths.push(p);
        } else {
          deletedPaths.push(p);
        }
      }
    }

    // Phase 3: Detect moves — deleted files go into recentlyDeleted with their hash
    for (const p of deletedPaths) {
      const storedHash = this.getStoredHash(p);
      if (storedHash) {
        this.recentlyDeleted.set(storedHash, { path: p, hash: storedHash, timestamp: Date.now() });
      }
      this.db.run("DELETE FROM files WHERE path = ?", [p]);
    }

    // Phase 3: Check created files against recently deleted
    for (const p of createdPaths) {
      const absPath = join(this.projectRoot, p);
      // Compute hash for the new file
      let newHash = "";
      try {
        const file = Bun.file(absPath);
        const slice = file.slice(0, 65536);
        const data = await slice.arrayBuffer();
        newHash = createHash("sha256").update(Buffer.from(data)).digest("hex").slice(0, 16);
      } catch {}

      const match = newHash ? this.recentlyDeleted.get(newHash) : null;
      if (match && Date.now() - match.timestamp < 5000) {
        // This is a move/rename! Notify the server to migrate context
        console.log(`Move detected: ${match.path} → ${p}`);
        this.recentlyDeleted.delete(newHash);
        if (this.onFileMoved) {
          try { await this.onFileMoved(match.path, p, newHash); } catch (e) {
            console.error("Error handling file move:", e);
          }
        }
      }
      // Index the new/moved file
      await this.indexFile(p, absPath);
    }

    // Run extraction if queued
    this.processExtractionQueue();
  }

  // ── Claude Extraction Pipeline ──

  /** Process queued files through Claude for structured extraction */
  async processExtractionQueue() {
    if (this.extracting || this.extractionQueue.length === 0 || !this.apiKey) return;
    this.extracting = true;

    try {
      while (this.extractionQueue.length > 0) {
        const relPath = this.extractionQueue.shift()!;
        try {
          await this.extractStructuredData(relPath);
        } catch (e) {
          console.error(`Extraction failed for ${relPath}:`, e);
        }
        // Small delay between extractions to avoid rate limiting
        await new Promise(r => setTimeout(r, 500));
      }
    } finally {
      this.extracting = false;
    }
  }

  private async extractStructuredData(relPath: string) {
    const fileRow = this.db.query("SELECT id, file_type FROM files WHERE path = ?").get(relPath) as { id: number; file_type: string } | null;
    if (!fileRow) return;

    // Check if we already have extracted chunks (not full_text)
    const existingChunks = this.db.query("SELECT COUNT(*) as count FROM chunks WHERE file_id = ? AND chunk_type != 'full_text'").get(fileRow.id) as { count: number };
    if (existingChunks.count > 0) return; // Already extracted

    // Get the file content
    let content = "";
    const absPath = join(this.projectRoot, relPath);

    if (fileRow.file_type === "text") {
      try { content = await readFile(absPath, "utf-8"); } catch { return; }
      content = content.slice(0, MAX_TEXT_SIZE);
    } else if (fileRow.file_type === "pdf") {
      // For PDFs, we'd need to extract text. For now, skip — the annotation sync
      // captures any human annotations on PDFs.
      return;
    } else {
      return;
    }

    if (content.trim().length < 50) return; // Too short to extract

    // Get any existing annotations for this file
    const annotations = this.db.query("SELECT text, author FROM annotations WHERE file_id = ?").all(fileRow.id) as { text: string; author: string }[];
    const annotationContext = annotations.length > 0
      ? "\n\nExisting annotations on this file:\n" + annotations.map(a => `[${a.author}]: ${a.text}`).join("\n")
      : "";

    // Call Claude (haiku for cost efficiency)
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-20250514",
          max_tokens: 1024,
          messages: [{
            role: "user",
            content: `Extract structured information from this document. Return ONLY valid JSON with this exact structure:

{
  "summary": "2-3 sentence summary",
  "decisions": ["decision 1", "decision 2"],
  "action_items": ["action item 1"],
  "commitments": ["person committed to X by date"],
  "people": ["name1", "name2"],
  "topics": ["topic1", "topic2"],
  "dates": ["2026-01-15"]
}

All fields are arrays of strings except summary which is a single string. Use empty arrays if nothing found. Only include information explicitly stated in the document.
${annotationContext}

Document "${basename(relPath)}":
${content}`,
          }],
        }),
      });

      if (!res.ok) return;

      const data = await res.json() as any;
      const text = data.content?.[0]?.text;
      if (!text) return;

      // Parse JSON from response (handle markdown code blocks)
      let jsonStr = text;
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonStr = jsonMatch[1];

      const extracted = JSON.parse(jsonStr.trim());
      const now = new Date().toISOString();
      const peopleStr = (extracted.people || []).join(", ");

      // Store summary chunk
      if (extracted.summary) {
        this.db.run(
          "INSERT INTO chunks (file_id, chunk_type, content, people, created_at) VALUES (?,?,?,?,?)",
          [fileRow.id, "summary", extracted.summary, peopleStr, now]
        );
      }

      // Store decisions
      for (const d of extracted.decisions || []) {
        this.db.run(
          "INSERT INTO chunks (file_id, chunk_type, content, people, created_at) VALUES (?,?,?,?,?)",
          [fileRow.id, "decision", d, peopleStr, now]
        );
      }

      // Store action items
      for (const a of extracted.action_items || []) {
        this.db.run(
          "INSERT INTO chunks (file_id, chunk_type, content, people, created_at) VALUES (?,?,?,?,?)",
          [fileRow.id, "action_item", a, peopleStr, now]
        );
      }

      // Store commitments
      for (const c of extracted.commitments || []) {
        this.db.run(
          "INSERT INTO chunks (file_id, chunk_type, content, people, created_at) VALUES (?,?,?,?,?)",
          [fileRow.id, "commitment", c, peopleStr, now]
        );
      }

      // Store topics as a single chunk
      if (extracted.topics?.length > 0) {
        this.db.run(
          "INSERT INTO chunks (file_id, chunk_type, content, people, created_at) VALUES (?,?,?,?,?)",
          [fileRow.id, "topics", extracted.topics.join(", "), peopleStr, now]
        );
      }

      // Store date references
      for (const d of extracted.dates || []) {
        this.db.run(
          "UPDATE chunks SET date_ref = ? WHERE file_id = ? AND chunk_type = 'summary'",
          [d, fileRow.id]
        );
      }

    } catch (e) {
      // JSON parse or network error — silently skip
    }
  }

  // ── Search ──

  /** Full-text search across chunks and annotations */
  search(query: string, filters?: SearchFilters, limit = 10): SearchResult[] {
    // Build FTS query
    const ftsQuery = query.split(/\s+/).map(w => `"${w.replace(/"/g, "")}"*`).join(" ");

    let sql = `
      SELECT
        f.id as fileId, f.path as filePath, f.name as fileName, f.file_type as fileType,
        c.chunk_type as chunkType, c.content, c.people, c.date_ref as dateRef,
        rank
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      JOIN files f ON f.id = c.file_id
      WHERE chunks_fts MATCH ?
    `;
    const params: any[] = [ftsQuery];

    if (filters?.people?.length) {
      const peopleClauses = filters.people.map(() => "c.people LIKE ?").join(" OR ");
      sql += ` AND (${peopleClauses})`;
      params.push(...filters.people.map(p => `%${p}%`));
    }
    if (filters?.chunk_type?.length) {
      sql += ` AND c.chunk_type IN (${filters.chunk_type.map(() => "?").join(",")})`;
      params.push(...filters.chunk_type);
    }
    if (filters?.directory) {
      sql += ` AND f.dir LIKE ?`;
      params.push(`${filters.directory}%`);
    }
    if (filters?.file_type) {
      sql += ` AND f.file_type = ?`;
      params.push(filters.file_type);
    }
    if (filters?.date_from) {
      sql += ` AND (c.date_ref >= ? OR c.created_at >= ?)`;
      params.push(filters.date_from, filters.date_from);
    }
    if (filters?.date_to) {
      sql += ` AND (c.date_ref <= ? OR c.created_at <= ?)`;
      params.push(filters.date_to, filters.date_to);
    }

    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    try {
      const results = this.db.query(sql).all(...params) as SearchResult[];

      // Also search annotations
      let annSql = `
        SELECT
          f.id as fileId, f.path as filePath, f.name as fileName, f.file_type as fileType,
          'annotation' as chunkType, a.text as content, NULL as people, NULL as dateRef,
          rank
        FROM annotations_fts
        JOIN annotations a ON a.id = annotations_fts.rowid
        JOIN files f ON f.id = a.file_id
        WHERE annotations_fts MATCH ?
      `;
      const annParams: any[] = [ftsQuery];

      if (filters?.directory) {
        annSql += ` AND f.dir LIKE ?`;
        annParams.push(`${filters.directory}%`);
      }

      annSql += ` ORDER BY rank LIMIT ?`;
      annParams.push(limit);

      const annResults = this.db.query(annSql).all(...annParams) as SearchResult[];

      // Merge and sort by rank, deduplicate by file
      const merged = [...results, ...annResults];
      merged.sort((a, b) => a.rank - b.rank);
      return merged.slice(0, limit);
    } catch (e) {
      // FTS query syntax error — fall back to empty
      return [];
    }
  }

  // ── Stats ──

  getStats(): IndexStats {
    const totalFiles = (this.db.query("SELECT COUNT(*) as c FROM files").get() as { c: number }).c;
    const totalChunks = (this.db.query("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
    const totalAnnotations = (this.db.query("SELECT COUNT(*) as c FROM annotations").get() as { c: number }).c;
    const lastRow = this.db.query("SELECT indexed_at FROM files ORDER BY indexed_at DESC LIMIT 1").get() as { indexed_at: string } | null;
    const pendingExtraction = this.extractionQueue.length;

    return {
      totalFiles,
      totalChunks,
      totalAnnotations,
      lastIndexed: lastRow?.indexed_at ?? null,
      indexing: this.indexing,
      pendingExtraction,
    };
  }

  // ── Reindex ──

  /** Drop all data and rebuild from scratch */
  async reindex(): Promise<{ indexed: number; skipped: number; removed: number }> {
    this.db.run("DELETE FROM chunks");
    this.db.run("DELETE FROM annotations");
    this.db.run("DELETE FROM files");
    return this.fullScan();
  }

  close() {
    this.stopWatcher();
    this.db.close();
  }
}
