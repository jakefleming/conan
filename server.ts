import { readdir, readFile, writeFile, stat, mkdir } from "fs/promises";
import { join, extname, basename, dirname, normalize } from "path";
import { existsSync } from "fs";

const ALLOWED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif",
  ".pdf", ".svg",
  ".txt", ".md", ".doc", ".docx",
]);

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
  ".heif": "image/heif", ".svg": "image/svg+xml", ".pdf": "application/pdf",
  ".txt": "text/plain", ".md": "text/plain",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const CONTEXT_FILE = ".context.json";
const SETTINGS_FILE = ".annotator-settings.json";
const SUMMARY_FILE = "SUMMARY.md";
const SUMMARY_HISTORY_DIR = ".summary-history";
const HIDDEN_DIRS = new Set([".thumbs", ".summary-history", ".git", ".DS_Store"]);
const PORT = 3333;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".svg"]);

// ── Path helpers ──

function splitRelPath(relativePath: string): { dir: string; base: string } {
  const lastSlash = relativePath.lastIndexOf("/");
  if (lastSlash === -1) return { dir: "", base: relativePath };
  return { dir: relativePath.substring(0, lastSlash), base: relativePath.substring(lastSlash + 1) };
}

function safePath(relativePath: string): string {
  const resolved = normalize(join(resolvedFolder, relativePath));
  if (!resolved.startsWith(resolvedFolder)) {
    throw new Error("Path traversal blocked");
  }
  return resolved;
}

// ── Content hashing ──

async function computeFileHash(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const slice = file.slice(0, 65536);
  const buffer = await slice.arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new Uint8Array(buffer));
  return hasher.digest("hex").substring(0, 16);
}

// ── Directory tree (cached) ──

type TreeEntry = {
  name: string;
  path: string;
  fileCount: number;
  annotatedCount: number;
  children: TreeEntry[];
};

let treeCache: { data: TreeEntry; ts: number } | null = null;
const TREE_TTL = 5000;

async function scanTree(dir: string, relPath: string): Promise<TreeEntry> {
  const entries = await readdir(dir, { withFileTypes: true });
  const children: TreeEntry[] = [];
  let fileCount = 0;

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === SUMMARY_FILE) continue;
    if (HIDDEN_DIRS.has(entry.name)) continue;

    if (entry.isDirectory()) {
      const childPath = relPath ? `${relPath}/${entry.name}` : entry.name;
      children.push(await scanTree(join(dir, entry.name), childPath));
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (ALLOWED_EXTENSIONS.has(ext)) fileCount++;
    }
  }

  // Read context to count annotated files
  let annotatedCount = 0;
  const contextPath = join(dir, CONTEXT_FILE);
  if (existsSync(contextPath)) {
    try {
      const raw = await readFile(contextPath, "utf-8");
      const ctx = JSON.parse(raw) as ContextData;
      annotatedCount = Object.values(ctx).filter(f => f.status === "annotated").length;
    } catch {}
  }

  return { name: basename(dir), path: relPath, fileCount, annotatedCount, children };
}

async function getTree(): Promise<TreeEntry> {
  if (treeCache && Date.now() - treeCache.ts < TREE_TTL) return treeCache.data;
  const tree = await scanTree(resolvedFolder, "");
  treeCache = { data: tree, ts: Date.now() };
  return tree;
}

function invalidateTreeCache() { treeCache = null; }

type Settings = { apiKey?: string };

async function readSettings(): Promise<Settings> {
  const settingsPath = join(import.meta.dir, SETTINGS_FILE);
  if (!existsSync(settingsPath)) return {};
  const raw = await readFile(settingsPath, "utf-8");
  return JSON.parse(raw);
}

async function writeSettings(settings: Settings): Promise<void> {
  const settingsPath = join(import.meta.dir, SETTINGS_FILE);
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
}

const pendingAskClaude = new Set<string>();

async function askClaude(relPath: string): Promise<string> {
  if (pendingAskClaude.has(relPath)) {
    throw new Error("Already analyzing this file — please wait for the current request to finish.");
  }
  pendingAskClaude.add(relPath);
  const settings = await readSettings();
  if (!settings.apiKey) throw new Error("No API key configured");

  const { dir, base } = splitRelPath(relPath);
  const filePath = safePath(relPath);
  const ext = extname(base).toLowerCase();
  const isImage = IMAGE_EXTENSIONS.has(ext);

  // Build context from existing comments
  const context = await readContext(dir);
  const fileCtx = context[base];
  let existingContext = "";
  if (fileCtx?.comments?.length) {
    existingContext = "\n\nExisting comments on this file:\n" +
      fileCtx.comments.map(c => {
        const regionNote = c.region
          ? ` (region: ${Math.round(c.region.x)}%-${Math.round(c.region.x + c.region.w)}% x, ${Math.round(c.region.y)}%-${Math.round(c.region.y + c.region.h)}% y)`
          : "";
        return `[${c.author}]${regionNote}: ${c.text}`;
      }).join("\n");
  }

  const messages: any[] = [];
  const content: any[] = [];

  if (isImage) {
    const imageData = await readFile(filePath);
    const base64 = imageData.toString("base64");
    const mediaType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
    content.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: base64 },
    });
  }

  content.push({
    type: "text",
    text: `You are a technical analyst reviewing a file called "${base}" that was captured during an in-person product/design session. The user has already provided voice annotations with their own context about what this file contains.${existingContext}

${isImage ? "Look at this image carefully. Read ALL handwritten text, labels, arrows, and diagram elements." : `This is a ${ext} file.`}

Your job is to ADD VALUE beyond what the user already said. Follow these rules strictly:
1. Start with "Implementation notes from reviewing sketch + user context:" (or similar)
2. Use a numbered list. Keep each point to 2-3 sentences max.
3. First, identify any specific text, labels, UI elements, or details visible in the image that the user did NOT mention.
4. Then add implementation notes: what does this mean for the codebase? What data models, APIs, or components does this imply?
5. Flag any ambiguities or open questions worth clarifying with the team.
6. Do NOT repeat what the user already said. Do NOT give generic advice about HIPAA, competitive analysis, or best practices unless directly relevant to something visible in the image.
7. Do NOT use bold/header markdown formatting. Plain text with numbered points only.
8. Keep it under 400 words. Be specific and actionable, not generic.`,
  });

  messages.push({ role: "user", content });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    pendingAskClaude.delete(relPath);
    throw new Error(`Claude API error: ${res.status} ${err}`);
  }

  const data = await res.json() as any;
  pendingAskClaude.delete(relPath);
  return data.content[0]?.text ?? "No response";
}

const pendingAutoAnnotate = new Set<string>();

async function autoAnnotate(relPath: string): Promise<{ region: Region; text: string }[]> {
  if (pendingAutoAnnotate.has(relPath)) {
    throw new Error("Already auto-annotating this file — please wait.");
  }
  pendingAutoAnnotate.add(relPath);
  const settings = await readSettings();
  if (!settings.apiKey) throw new Error("No API key configured");

  const { dir, base } = splitRelPath(relPath);
  const filePath = safePath(relPath);
  const ext = extname(base).toLowerCase();
  const isImage = IMAGE_EXTENSIONS.has(ext);
  if (!isImage) {
    pendingAutoAnnotate.delete(relPath);
    throw new Error("Auto-annotate only works on images");
  }

  // Build context from existing comments
  const context = await readContext(dir);
  const fileCtx = context[base];
  let existingContext = "";
  if (fileCtx?.comments?.length) {
    existingContext = "\n\nExisting comments on this file (avoid duplicating these areas):\n" +
      fileCtx.comments.map(c => {
        const regionNote = c.region
          ? ` (region: ${Math.round(c.region.x)}%-${Math.round(c.region.x + c.region.w)}% x, ${Math.round(c.region.y)}%-${Math.round(c.region.y + c.region.h)}% y)`
          : "";
        return `[${c.author}]${regionNote}: ${c.text}`;
      }).join("\n");
  }

  const imageData = await readFile(filePath);
  const base64 = imageData.toString("base64");
  const mediaType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";

  const messages = [{
    role: "user",
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: mediaType, data: base64 },
      },
      {
        type: "text",
        text: `You are analyzing a photo of a whiteboard, sketch, or document from a product/design session.${existingContext}

Your task: find each distinct piece of handwritten text, label, diagram element, or visual note in this image. For each one, draw a TIGHT bounding box around JUST that element and transcribe or describe it.

Think of this like OCR — each annotation should wrap ONE specific thing: a single label, a single list, a single diagram, a single arrow with text, etc. NOT large areas of the image.

Return ONLY a valid JSON array. No other text before or after.

Format: [{"region":{"x":N,"y":N,"w":N,"h":N},"text":"what this element says or shows"}]

Coordinate rules:
- x, y, w, h are percentages (0-100) of the FULL image width and height
- x,y = top-left corner of the box, w,h = width and height of the box
- Boxes should be TIGHT — just big enough to contain the element, with minimal padding
- Typical box width: 5-20% of image. If your box is wider than 40%, it's too big — break it into smaller pieces
- Overlapping boxes are OK when elements are close together

Content rules:
- Maximum 8 annotations
- Skip areas already covered by existing comments
- For handwritten text: transcribe it in your note
- For diagrams/arrows: briefly describe what they show
- Prioritize text and labels over blank space or decorative elements
- One element per annotation — do not group multiple distinct items into one large box
- IGNORE any faint text bleeding through from the other side of the paper. Only annotate text/drawings that are clearly written on the front-facing side`,
      },
    ],
  }];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    pendingAutoAnnotate.delete(relPath);
    throw new Error(`Claude API error: ${res.status} ${err}`);
  }

  const data = await res.json() as any;
  pendingAutoAnnotate.delete(relPath);
  const rawText = data.content[0]?.text ?? "";

  // Extract JSON array from response (Claude might wrap it in markdown code fences)
  const jsonMatch = rawText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Claude did not return a valid JSON array");

  let annotations: any[];
  try {
    annotations = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("Failed to parse Claude's JSON response");
  }

  // Validate and clean
  return annotations
    .filter((a: any) => a && a.region && typeof a.text === "string")
    .filter((a: any) => {
      const r = a.region;
      return typeof r.x === "number" && typeof r.y === "number" &&
             typeof r.w === "number" && typeof r.h === "number" &&
             r.w > 1 && r.h > 1;
    })
    .slice(0, 8)
    .map((a: any) => ({
      region: {
        x: Math.max(0, Math.min(100, a.region.x)),
        y: Math.max(0, Math.min(100, a.region.y)),
        w: Math.max(1, Math.min(100 - a.region.x, a.region.w)),
        h: Math.max(1, Math.min(100 - a.region.y, a.region.h)),
      },
      text: a.text,
    }));
}

// Target folder from CLI arg
const targetFolder = process.argv[2];
if (!targetFolder) {
  console.error("Usage: bun run server.ts /path/to/folder");
  process.exit(1);
}

const resolvedFolder = targetFolder.startsWith("/")
  ? targetFolder
  : join(process.cwd(), targetFolder);

if (!existsSync(resolvedFolder)) {
  console.error(`Folder not found: ${resolvedFolder}`);
  process.exit(1);
}

type Region = { x: number; y: number; w: number; h: number };
type Comment = { author: "user" | "claude"; text: string; ts: string; audio?: string; region?: Region };
type FileContext = { comments: Comment[]; status: "pending" | "annotated" | "skipped"; hash?: string };
type ContextData = Record<string, FileContext>;

async function readContext(subdir: string = ""): Promise<ContextData> {
  const contextPath = join(resolvedFolder, subdir, CONTEXT_FILE);
  if (!existsSync(contextPath)) return {};
  const raw = await readFile(contextPath, "utf-8");
  return JSON.parse(raw);
}

async function writeContext(data: ContextData, subdir: string = ""): Promise<void> {
  const contextPath = join(resolvedFolder, subdir, CONTEXT_FILE);
  await writeFile(contextPath, JSON.stringify(data, null, 2), "utf-8");
  invalidateTreeCache();
}

async function readSummary(subdir: string = ""): Promise<{ content: string | null; lastModified: string | null }> {
  const summaryPath = join(resolvedFolder, subdir, SUMMARY_FILE);
  if (!existsSync(summaryPath)) return { content: null, lastModified: null };
  const raw = await readFile(summaryPath, "utf-8");
  const stats = await stat(summaryPath);
  return { content: raw, lastModified: stats.mtime.toISOString() };
}

async function writeSummary(content: string, subdir: string = ""): Promise<void> {
  const summaryPath = join(resolvedFolder, subdir, SUMMARY_FILE);
  await writeFile(summaryPath, content, "utf-8");
}

async function ensureHistoryDir(subdir: string = ""): Promise<string> {
  const historyDir = join(resolvedFolder, subdir, SUMMARY_HISTORY_DIR);
  if (!existsSync(historyDir)) {
    await mkdir(historyDir, { recursive: true });
  }
  return historyDir;
}

async function listVersions(subdir: string = ""): Promise<number[]> {
  const historyDir = join(resolvedFolder, subdir, SUMMARY_HISTORY_DIR);
  if (!existsSync(historyDir)) return [];
  const entries = await readdir(historyDir);
  const versions = entries
    .filter(name => /^v\d+\.md$/.test(name))
    .map(name => parseInt(name.match(/^v(\d+)\.md$/)![1], 10))
    .sort((a, b) => a - b);
  return versions;
}

async function getNextVersion(subdir: string = ""): Promise<number> {
  const versions = await listVersions(subdir);
  return versions.length === 0 ? 1 : Math.max(...versions) + 1;
}

async function saveVersion(content: string, subdir: string = ""): Promise<number> {
  const historyDir = await ensureHistoryDir(subdir);
  const version = await getNextVersion(subdir);
  await writeFile(join(historyDir, `v${version}.md`), content, "utf-8");
  return version;
}

async function readVersion(version: number, subdir: string = ""): Promise<{ content: string; version: number } | null> {
  const filePath = join(resolvedFolder, subdir, SUMMARY_HISTORY_DIR, `v${version}.md`);
  if (!existsSync(filePath)) return null;
  const content = await readFile(filePath, "utf-8");
  return { content, version };
}

let pendingGenerate = false;

// Recursively collect all contexts from a directory tree
async function collectAllContexts(dir: string, relPath: string): Promise<{ dir: string; filename: string; fileCtx: FileContext }[]> {
  const results: { dir: string; filename: string; fileCtx: FileContext }[] = [];
  const context = await readContext(relPath);
  for (const [filename, fileCtx] of Object.entries(context)) {
    if (fileCtx.comments?.length) {
      results.push({ dir: relPath, filename, fileCtx });
    }
  }
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || HIDDEN_DIRS.has(entry.name)) continue;
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    results.push(...await collectAllContexts(join(dir, entry.name), childRel));
  }
  return results;
}

async function generateSummary(subdir: string = "", aggregate: boolean = false): Promise<{ content: string; version: number }> {
  if (pendingGenerate) throw new Error("Summary generation already in progress.");
  pendingGenerate = true;

  try {
    const settings = await readSettings();
    if (!settings.apiKey) throw new Error("No API key configured");

    let annotationDump = "";

    if (aggregate) {
      const allContexts = await collectAllContexts(join(resolvedFolder, subdir), subdir);
      if (allContexts.length === 0) throw new Error("No annotations to summarize.");
      for (const { dir, filename, fileCtx } of allContexts) {
        const displayName = dir ? `${dir}/${filename}` : filename;
        annotationDump += `\n## ${displayName} (status: ${fileCtx.status})\n`;
        for (let i = 0; i < fileCtx.comments.length; i++) {
          const c = fileCtx.comments[i];
          const regionNote = c.region
            ? ` (region: ${Math.round(c.region.x)}%-${Math.round(c.region.x + c.region.w)}% x, ${Math.round(c.region.y)}%-${Math.round(c.region.y + c.region.h)}% y)`
            : "";
          annotationDump += `- [${c.author.toUpperCase()}, #${i}]${regionNote} ${c.text}\n`;
        }
      }
    } else {
      const context = await readContext(subdir);
      const fileList = Object.entries(context);
      if (fileList.length === 0) throw new Error("No annotations to summarize.");
      for (const [filename, fileCtx] of fileList) {
        if (!fileCtx.comments || fileCtx.comments.length === 0) continue;
        const displayName = subdir ? `${subdir}/${filename}` : filename;
        annotationDump += `\n## ${displayName} (status: ${fileCtx.status})\n`;
        for (let i = 0; i < fileCtx.comments.length; i++) {
          const c = fileCtx.comments[i];
          const regionNote = c.region
            ? ` (region: ${Math.round(c.region.x)}%-${Math.round(c.region.x + c.region.w)}% x, ${Math.round(c.region.y)}%-${Math.round(c.region.y + c.region.h)}% y)`
            : "";
          annotationDump += `- [${c.author.toUpperCase()}, #${i}]${regionNote} ${c.text}\n`;
        }
      }
    }

    const summaryPrompt = `You are synthesizing annotations from a product/design session into a comprehensive summary document. Below are all files and their annotations. Each annotation is tagged [USER] or [CLAUDE].

RULES:
1. USER comments are the primary source of truth. They capture the intent, decisions, and context from the person who was in the room.
2. CLAUDE comments are AI-generated analysis. They may add useful implementation detail, but treat them as supplementary.
3. If a CLAUDE comment introduces claims, details, or interpretations that go beyond what any USER comment states, flag it in "Items Needing Attention." Do not silently incorporate AI speculation as fact.
4. If USER comments contradict each other or are ambiguous, call that out as needing clarification.
5. Structure the output as clean markdown with these sections in this exact order:
   - # Session Summary (1-2 sentence overview of what this session covers)
   - ## Key Decisions and Themes (bullet points of the main decisions and recurring themes from USER comments)
   - ## File-by-File Notes (brief section per file, synthesizing user intent and any useful AI additions)
   - ## Design Deliverables
   - ### Screens and Components to Design (numbered list of specific screens, components, modals, or views that need wireframes/mockups, with 1-2 sentence description each)
   - ### User Flows to Map (multi-step flows that need flow diagrams or journey maps)
   - ### Data and Content Requirements (data fields, labels, metrics, or content blocks the design needs to account for)
   - ## Open Questions (anything ambiguous from both a product and design perspective -- things needing clarification before proceeding)
   - ## Items Needing Attention (anything AI-introduced that needs human review)
6. Write in plain, direct language. No filler. No generic advice.
7. Do not use emoji.
8. If there is nothing for "Items Needing Attention," include the section header with "None identified." beneath it.
9. If a CLAUDE comment introduced a UI element or design detail that the USER did not mention, flag it as "(AI-suggested, verify with team)" inline.
10. Be specific. Reference the exact features, modules, metrics, and UI elements mentioned in the annotations. Do not invent screens that were not discussed.
11. CITATIONS: When referencing a specific comment, use this exact markdown link format:
   - To cite a comment: ["short verbatim quote"](comment:FILEPATH:INDEX)
     Example: ["vitality module tracks daily energy"](comment:IMG_5210.jpeg:0)
   - To reference an image/file: [FILENAME](image:FILEPATH)
     Example: [IMG_5210.jpeg](image:IMG_5210.jpeg)
   - FILEPATH is the relative path as shown in the annotations (e.g. "subdir/IMG_5210.jpeg" or just "IMG_5210.jpeg").
   - Quoted phrases must be 5-15 words extracted VERBATIM from the comment text.
   - INDEX must match the #N shown next to the comment author tag (e.g. [USER, #0] means index 0).
   - Use image references when discussing a specific file's content.
   - Every bullet point in "File-by-File Notes" and each item in "Screens and Components to Design" must include at least one comment citation.`;

    const prompt = `${summaryPrompt}

ANNOTATIONS:
${annotationDump}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Claude API error: ${res.status} ${err}`);
    }

    const data = (await res.json()) as any;
    const content = data.content[0]?.text ?? "No response";
    await writeSummary(content, subdir);
    const version = await saveVersion(content, subdir);
    return { content, version };
  } finally {
    pendingGenerate = false;
  }
}

type DirListing = {
  files: string[];
  directories: string[];
};

async function listFiles(subdir: string = ""): Promise<DirListing> {
  const dirPath = join(resolvedFolder, subdir);
  if (!existsSync(dirPath)) return { files: [], directories: [] };
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];
  const directories: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === CONTEXT_FILE || entry.name === SUMMARY_FILE) continue;
    if (HIDDEN_DIRS.has(entry.name)) continue;

    if (entry.isDirectory()) {
      directories.push(entry.name);
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (ALLOWED_EXTENSIONS.has(ext)) files.push(entry.name);
    }
  }

  return { files: files.sort(), directories: directories.sort() };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Orphan detection + reconcile ──

async function findOrphans(subdir: string = ""): Promise<{ filename: string; entry: FileContext }[]> {
  const context = await readContext(subdir);
  const dirPath = join(resolvedFolder, subdir);
  const orphans: { filename: string; entry: FileContext }[] = [];
  for (const [filename, entry] of Object.entries(context)) {
    if (!existsSync(join(dirPath, filename))) {
      orphans.push({ filename, entry });
    }
  }
  return orphans;
}

async function reconcileAll(): Promise<{ migrated: { from: string; to: string; filename: string }[]; stillOrphaned: number }> {
  // 1. Collect all orphans with hashes
  const orphansByHash = new Map<string, { subdir: string; filename: string; entry: FileContext }>();
  async function collectOrphans(dir: string, relPath: string) {
    const context = await readContext(relPath);
    const dirPath = join(resolvedFolder, relPath);
    for (const [filename, entry] of Object.entries(context)) {
      if (!existsSync(join(dirPath, filename)) && entry.hash) {
        orphansByHash.set(entry.hash, { subdir: relPath, filename, entry });
      }
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || HIDDEN_DIRS.has(e.name)) continue;
      const childRel = relPath ? `${relPath}/${e.name}` : e.name;
      await collectOrphans(join(dir, e.name), childRel);
    }
  }
  await collectOrphans(resolvedFolder, "");

  // Count total orphans (including hashless ones that can't be matched)
  let totalOrphans = 0;
  async function countAllOrphans(dir: string, relPath: string) {
    const context = await readContext(relPath);
    const dirPath = join(resolvedFolder, relPath);
    for (const [filename] of Object.entries(context)) {
      if (!existsSync(join(dirPath, filename))) totalOrphans++;
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || HIDDEN_DIRS.has(e.name)) continue;
      const childRel = relPath ? `${relPath}/${e.name}` : e.name;
      await countAllOrphans(join(dir, e.name), childRel);
    }
  }

  if (orphansByHash.size === 0) {
    await countAllOrphans(resolvedFolder, "");
    return { migrated: [], stillOrphaned: totalOrphans };
  }

  // 2. Scan all files, compute hashes for unannotated ones, try to match
  const migrated: { from: string; to: string; filename: string }[] = [];
  async function scanFiles(dir: string, relPath: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || HIDDEN_DIRS.has(e.name)) continue;
      if (e.isDirectory()) {
        const childRel = relPath ? `${relPath}/${e.name}` : e.name;
        await scanFiles(join(dir, e.name), childRel);
        continue;
      }
      const ext = extname(e.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;
      // Check if this file already has annotations
      const ctx = await readContext(relPath);
      if (ctx[e.name]?.comments?.length) continue;
      // Compute hash and check for match
      const hash = await computeFileHash(join(dir, e.name));
      const orphan = orphansByHash.get(hash);
      if (orphan) {
        // Migrate: remove from old context, add to new context
        const oldContext = await readContext(orphan.subdir);
        delete oldContext[orphan.filename];
        await writeContext(oldContext, orphan.subdir);

        const newContext = await readContext(relPath);
        newContext[e.name] = { ...orphan.entry, hash };
        await writeContext(newContext, relPath);

        const fromPath = orphan.subdir ? `${orphan.subdir}/${orphan.filename}` : orphan.filename;
        const toPath = relPath ? `${relPath}/${e.name}` : e.name;
        migrated.push({ from: fromPath, to: toPath, filename: e.name });
        orphansByHash.delete(hash);
      }
    }
  }
  await scanFiles(resolvedFolder, "");

  invalidateTreeCache();
  await countAllOrphans(resolvedFolder, "");
  return { migrated, stillOrphaned: totalOrphans };
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120, // Claude API calls with large images can take a while
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const dirParam = url.searchParams.get("dir") ?? "";

    // Static files
    if (path === "/" || path === "/index.html") {
      const file = Bun.file(join(import.meta.dir, "public", "index.html"));
      return new Response(file, { headers: { "Content-Type": "text/html" } });
    }

    // API: config
    if (path === "/api/config") {
      const settings = await readSettings();
      return json({ folder: resolvedFolder, hasApiKey: !!settings.apiKey });
    }

    // API: settings
    if (path === "/api/settings" && req.method === "GET") {
      const settings = await readSettings();
      return json({ hasApiKey: !!settings.apiKey });
    }
    if (path === "/api/settings" && req.method === "POST") {
      const body = (await req.json()) as { apiKey: string };
      await writeSettings({ apiKey: body.apiKey });
      return json({ ok: true });
    }

    // API: directory tree
    if (path === "/api/tree" && req.method === "GET") {
      const tree = await getTree();
      return json(tree);
    }

    // API: orphans for a directory
    if (path === "/api/orphans" && req.method === "GET") {
      try {
        if (dirParam) safePath(dirParam);
        const orphans = await findOrphans(dirParam);
        return json({ orphans, count: orphans.length });
      } catch (e: any) {
        return json({ error: e.message }, 400);
      }
    }

    // API: clean orphaned annotations from a directory's .context.json
    if (path === "/api/orphans/clean" && req.method === "POST") {
      try {
        if (dirParam) safePath(dirParam);
        const context = await readContext(dirParam);
        const dirPath = join(resolvedFolder, dirParam);
        let removed = 0;
        for (const filename of Object.keys(context)) {
          if (!existsSync(join(dirPath, filename))) {
            delete context[filename];
            removed++;
          }
        }
        await writeContext(context, dirParam);
        return json({ removed });
      } catch (e: any) {
        return json({ error: e.message }, 400);
      }
    }

    // API: reconcile moved files
    if (path === "/api/reconcile" && req.method === "POST") {
      try {
        const result = await reconcileAll();
        return json(result);
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // API: ask Claude to analyze a file
    const askMatch = path.match(/^\/api\/files\/(.+)\/ask-claude$/);
    if (askMatch && req.method === "POST") {
      const relPath = decodeURIComponent(askMatch[1]);
      const { dir, base } = splitRelPath(relPath);
      try {
        safePath(relPath);
        const analysis = await askClaude(relPath);
        const context = await readContext(dir);
        if (!context[base]) {
          context[base] = { comments: [], status: "pending" };
        }
        context[base].comments.push({
          author: "claude",
          text: analysis,
          ts: new Date().toISOString(),
        });
        context[base].status = "annotated";
        await writeContext(context, dir);
        return json({ ok: true, text: analysis });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // API: auto-annotate — Claude identifies regions and creates annotated comments
    const autoAnnotateMatch = path.match(/^\/api\/files\/(.+)\/auto-annotate$/);
    if (autoAnnotateMatch && req.method === "POST") {
      const relPath = decodeURIComponent(autoAnnotateMatch[1]);
      const { dir, base } = splitRelPath(relPath);
      try {
        safePath(relPath);
        const annotations = await autoAnnotate(relPath);
        const context = await readContext(dir);
        if (!context[base]) {
          context[base] = { comments: [], status: "pending" };
        }
        const ts = new Date().toISOString();
        for (const ann of annotations) {
          context[base].comments.push({
            author: "claude",
            text: ann.text,
            ts,
            region: ann.region,
          });
        }
        context[base].status = "annotated";
        await writeContext(context, dir);
        return json({ ok: true, count: annotations.length });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // API: list files with context (supports ?dir= for subdirectory)
    if (path === "/api/files" && req.method === "GET") {
      try {
        if (dirParam) safePath(dirParam);
        const { files: fileNames, directories } = await listFiles(dirParam);
        const context = await readContext(dirParam);

        // Backfill hashes for annotated files that don't have one yet
        let contextModified = false;
        for (const name of fileNames) {
          if (context[name]?.comments?.length && !context[name].hash) {
            try {
              context[name].hash = await computeFileHash(join(resolvedFolder, dirParam, name));
              contextModified = true;
            } catch {}
          }
        }
        if (contextModified) await writeContext(context, dirParam);

        // Build directory entries with annotation counts
        const dirEntries = [];
        for (const dirName of directories) {
          const subPath = dirParam ? `${dirParam}/${dirName}` : dirName;
          const subCtx = await readContext(subPath);
          const fileCount = (await listFiles(subPath)).files.length;
          const annotatedCount = Object.values(subCtx).filter(f => f.status === "annotated").length;
          dirEntries.push({
            type: "directory" as const,
            name: dirName,
            path: subPath,
            fileCount,
            annotatedCount,
          });
        }

        const fileEntries = fileNames.map((name) => ({
          type: "file" as const,
          name,
          path: dirParam ? `${dirParam}/${name}` : name,
          dir: dirParam,
          ext: extname(name).toLowerCase(),
          status: context[name]?.status ?? "pending",
          commentCount: context[name]?.comments?.length ?? 0,
          comments: context[name]?.comments ?? [],
        }));

        return json([...dirEntries, ...fileEntries]);
      } catch (e: any) {
        return json({ error: e.message }, 400);
      }
    }

    // API: file thumbnail (resized for grid view)
    const thumbMatch = path.match(/^\/api\/files\/(.+)\/thumb$/);
    if (thumbMatch && req.method === "GET") {
      const relPath = decodeURIComponent(thumbMatch[1]);
      const { dir, base } = splitRelPath(relPath);
      let filePath: string;
      try { filePath = safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      if (!existsSync(filePath)) return json({ error: "Not found" }, 404);
      const ext = extname(base).toLowerCase();
      const imageExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif"]);
      if (!imageExts.has(ext)) {
        const mime = MIME_TYPES[ext] ?? "application/octet-stream";
        return new Response(Bun.file(filePath), { headers: { "Content-Type": mime } });
      }
      const thumbDir = join(resolvedFolder, dir, ".thumbs");
      if (!existsSync(thumbDir)) await mkdir(thumbDir, { recursive: true });
      const thumbPath = join(thumbDir, `${basename(base, ext)}.jpg`);
      if (!existsSync(thumbPath)) {
        const proc = Bun.spawnSync([
          "sips", "-s", "format", "jpeg", "-s", "formatOptions", "70",
          "-Z", "400", filePath, "--out", thumbPath,
        ]);
        if (proc.exitCode !== 0) {
          const mime = MIME_TYPES[ext] ?? "application/octet-stream";
          return new Response(Bun.file(filePath), { headers: { "Content-Type": mime } });
        }
      }
      return new Response(Bun.file(thumbPath), {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" },
      });
    }

    // API: file preview
    const previewMatch = path.match(/^\/api\/files\/(.+)\/preview$/);
    if (previewMatch && req.method === "GET") {
      const relPath = decodeURIComponent(previewMatch[1]);
      let filePath: string;
      try { filePath = safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      if (!existsSync(filePath)) return json({ error: "Not found" }, 404);
      const ext = extname(relPath).toLowerCase();
      const mime = MIME_TYPES[ext] ?? "application/octet-stream";
      const file = Bun.file(filePath);
      return new Response(file, {
        headers: {
          "Content-Type": mime,
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // API: upload audio for a file
    const audioMatch = path.match(/^\/api\/files\/(.+)\/audio$/);
    if (audioMatch && req.method === "POST") {
      const relPath = decodeURIComponent(audioMatch[1]);
      const { dir, base } = splitRelPath(relPath);
      try { safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      const blob = await req.blob();
      const ext = blob.type.includes("webm") ? "webm" : blob.type.includes("mp4") ? "m4a" : "ogg";
      const ts = Date.now();
      const audioBaseName = `.audio_${basename(base, extname(base))}_${ts}.${ext}`;
      const audioRelPath = dir ? `${dir}/${audioBaseName}` : audioBaseName;
      const audioPath = join(resolvedFolder, audioRelPath);
      await writeFile(audioPath, Buffer.from(await blob.arrayBuffer()));
      return json({ audioFilename: audioRelPath });
    }

    // API: serve audio file (relative path from root)
    const audioServeMatch = path.match(/^\/api\/audio\/(.+)$/);
    if (audioServeMatch && req.method === "GET") {
      const audioRelPath = decodeURIComponent(audioServeMatch[1]);
      let audioPath: string;
      try { audioPath = safePath(audioRelPath); } catch { return json({ error: "Invalid path" }, 400); }
      if (!existsSync(audioPath)) return json({ error: "Not found" }, 404);
      const file = Bun.file(audioPath);
      return new Response(file, { headers: { "Content-Type": "audio/webm" } });
    }

    // API: add comment
    const commentMatch = path.match(/^\/api\/files\/(.+)\/comments$/);
    if (commentMatch && req.method === "POST") {
      const relPath = decodeURIComponent(commentMatch[1]);
      const { dir, base } = splitRelPath(relPath);
      try { safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      const body = (await req.json()) as { author: string; text: string; audio?: string; region?: Region };
      if (!body.text?.trim()) return json({ error: "Empty comment" }, 400);

      const context = await readContext(dir);
      if (!context[base]) {
        context[base] = { comments: [], status: "pending" };
      }
      // Compute hash on first annotation if missing
      if (!context[base].hash) {
        try {
          context[base].hash = await computeFileHash(join(resolvedFolder, relPath));
        } catch {}
      }
      const comment: Comment = {
        author: (body.author === "claude" ? "claude" : "user") as "user" | "claude",
        text: body.text.trim(),
        ts: new Date().toISOString(),
      };
      if (body.audio) comment.audio = body.audio;
      if (body.region) comment.region = body.region;
      context[base].comments.push(comment);
      context[base].status = "annotated";
      await writeContext(context, dir);
      return json(context[base]);
    }

    // API: update status
    const statusMatch = path.match(/^\/api\/files\/(.+)\/status$/);
    if (statusMatch && req.method === "PATCH") {
      const relPath = decodeURIComponent(statusMatch[1]);
      const { dir, base } = splitRelPath(relPath);
      try { safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      const body = (await req.json()) as { status: string };
      const validStatuses = ["pending", "annotated", "skipped"];
      if (!validStatuses.includes(body.status)) return json({ error: "Invalid status" }, 400);

      const context = await readContext(dir);
      if (!context[base]) {
        context[base] = { comments: [], status: "pending" };
      }
      context[base].status = body.status as FileContext["status"];
      await writeContext(context, dir);
      return json(context[base]);
    }

    // API: delete comment
    const deleteCommentMatch = path.match(/^\/api\/files\/(.+)\/comments\/(\d+)$/);
    if (deleteCommentMatch && req.method === "DELETE") {
      const relPath = decodeURIComponent(deleteCommentMatch[1]);
      const { dir, base } = splitRelPath(relPath);
      try { safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      const index = parseInt(deleteCommentMatch[2], 10);
      const context = await readContext(dir);
      if (!context[base]) return json({ error: "Not found" }, 404);
      if (index < 0 || index >= context[base].comments.length) return json({ error: "Invalid index" }, 400);
      context[base].comments.splice(index, 1);
      if (context[base].comments.length === 0) {
        context[base].status = "pending";
      }
      await writeContext(context, dir);
      return json(context[base]);
    }

    // API: update a comment's region
    const regionMatch = path.match(/^\/api\/files\/(.+)\/comments\/(\d+)\/region$/);
    if (regionMatch && req.method === "PUT") {
      const relPath = decodeURIComponent(regionMatch[1]);
      const { dir, base } = splitRelPath(relPath);
      try { safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      const index = parseInt(regionMatch[2], 10);
      const body = (await req.json()) as { region: Region };
      const context = await readContext(dir);
      if (!context[base]) return json({ error: "Not found" }, 404);
      if (index < 0 || index >= context[base].comments.length) return json({ error: "Invalid index" }, 400);
      context[base].comments[index].region = body.region;
      await writeContext(context, dir);
      return json({ ok: true });
    }

    // API: update comment text
    const textMatch = path.match(/^\/api\/files\/(.+)\/comments\/(\d+)\/text$/);
    if (textMatch && req.method === "PUT") {
      const relPath = decodeURIComponent(textMatch[1]);
      const { dir, base } = splitRelPath(relPath);
      try { safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      const index = parseInt(textMatch[2], 10);
      const body = (await req.json()) as { text: string };
      const context = await readContext(dir);
      if (!context[base]) return json({ error: "Not found" }, 404);
      if (index < 0 || index >= context[base].comments.length) return json({ error: "Invalid index" }, 400);
      context[base].comments[index].text = body.text;
      await writeContext(context, dir);
      return json({ ok: true });
    }

    // API: fix comment formatting with Claude
    const fixMatch = path.match(/^\/api\/files\/(.+)\/comments\/(\d+)\/fix$/);
    if (fixMatch && req.method === "POST") {
      const relPath = decodeURIComponent(fixMatch[1]);
      const { dir, base } = splitRelPath(relPath);
      try { safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      const index = parseInt(fixMatch[2], 10);
      const context = await readContext(dir);
      if (!context[base]) return json({ error: "Not found" }, 404);
      if (index < 0 || index >= context[base].comments.length) return json({ error: "Invalid index" }, 400);
      const comment = context[base].comments[index];
      const settings = await readSettings();
      if (!settings.apiKey) return json({ error: "No API key" }, 400);

      try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": settings.apiKey,
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 2048,
            messages: [{
              role: "user",
              content: `Fix the formatting and transcription errors in the following text. This was likely transcribed from speech, so fix run-on sentences, add proper punctuation, paragraph breaks, and correct obvious mistranscriptions. Keep the meaning and content identical — only fix formatting and grammar. Return ONLY the fixed text, nothing else.\n\nText:\n${comment.text}`,
            }],
          }),
        });
        const data = await response.json() as any;
        const fixedText = data.content?.[0]?.text?.trim();
        if (fixedText) {
          context[base].comments[index].text = fixedText;
          await writeContext(context, dir);
          return json({ ok: true, text: fixedText });
        }
        return json({ error: "No response from Claude" }, 500);
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // API: get summary (supports ?dir=)
    if (path === "/api/summary" && req.method === "GET") {
      try {
        if (dirParam) safePath(dirParam);
        const summary = await readSummary(dirParam);
        return json(summary);
      } catch (e: any) {
        return json({ error: e.message }, 400);
      }
    }

    // API: save summary (manual edit, supports ?dir=)
    if (path === "/api/summary" && req.method === "POST") {
      try {
        if (dirParam) safePath(dirParam);
        const body = (await req.json()) as { content: string };
        await writeSummary(body.content, dirParam);
        return json({ ok: true });
      } catch (e: any) {
        return json({ error: e.message }, 400);
      }
    }

    // API: generate summary (supports ?dir= and ?aggregate=true)
    if (path === "/api/summary/generate" && req.method === "POST") {
      try {
        if (dirParam) safePath(dirParam);
        const aggregate = url.searchParams.get("aggregate") === "true";
        const { content, version } = await generateSummary(dirParam, aggregate);
        const versions = await listVersions(dirParam);
        return json({ ok: true, content, version, totalVersions: versions.length });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // API: list summary versions (supports ?dir=)
    if (path === "/api/summary/versions" && req.method === "GET") {
      try {
        if (dirParam) safePath(dirParam);
        const versions = await listVersions(dirParam);
        return json({ versions, total: versions.length });
      } catch (e: any) {
        return json({ error: e.message }, 400);
      }
    }

    // API: get specific summary version (supports ?dir=)
    const versionMatch = path.match(/^\/api\/summary\/versions\/(\d+)$/);
    if (versionMatch && req.method === "GET") {
      try {
        if (dirParam) safePath(dirParam);
        const versionNum = parseInt(versionMatch[1], 10);
        const result = await readVersion(versionNum, dirParam);
        if (!result) return json({ error: "Version not found" }, 404);
        const versions = await listVersions(dirParam);
        return json({ content: result.content, version: result.version, totalVersions: versions.length });
      } catch (e: any) {
        return json({ error: e.message }, 400);
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Context Annotator running at http://localhost:${PORT}`);
console.log(`Watching folder: ${resolvedFolder}`);
