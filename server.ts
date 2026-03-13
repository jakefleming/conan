import { readdir, readFile, writeFile, stat, mkdir } from "fs/promises";
import { join, extname, basename } from "path";
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
const PORT = 3333;

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".svg"]);

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

async function askClaude(filename: string): Promise<string> {
  if (pendingAskClaude.has(filename)) {
    throw new Error("Already analyzing this file — please wait for the current request to finish.");
  }
  pendingAskClaude.add(filename);
  const settings = await readSettings();
  if (!settings.apiKey) throw new Error("No API key configured");

  const filePath = join(resolvedFolder, filename);
  const ext = extname(filename).toLowerCase();
  const isImage = IMAGE_EXTENSIONS.has(ext);

  // Build context from existing comments
  const context = await readContext();
  const fileCtx = context[filename];
  let existingContext = "";
  if (fileCtx?.comments?.length) {
    existingContext = "\n\nExisting comments on this file:\n" +
      fileCtx.comments.map(c => `[${c.author}]: ${c.text}`).join("\n");
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
    text: `You are a technical analyst reviewing a file called "${filename}" that was captured during an in-person product/design session. The user has already provided voice annotations with their own context about what this file contains.${existingContext}

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
    pendingAskClaude.delete(filename);
    throw new Error(`Claude API error: ${res.status} ${err}`);
  }

  const data = await res.json() as any;
  pendingAskClaude.delete(filename);
  return data.content[0]?.text ?? "No response";
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

type Comment = { author: "user" | "claude"; text: string; ts: string; audio?: string };
type FileContext = { comments: Comment[]; status: "pending" | "annotated" | "skipped" };
type ContextData = Record<string, FileContext>;

async function readContext(): Promise<ContextData> {
  const contextPath = join(resolvedFolder, CONTEXT_FILE);
  if (!existsSync(contextPath)) return {};
  const raw = await readFile(contextPath, "utf-8");
  return JSON.parse(raw);
}

async function writeContext(data: ContextData): Promise<void> {
  const contextPath = join(resolvedFolder, CONTEXT_FILE);
  await writeFile(contextPath, JSON.stringify(data, null, 2), "utf-8");
}

async function readSummary(): Promise<{ content: string | null; lastModified: string | null }> {
  const summaryPath = join(resolvedFolder, SUMMARY_FILE);
  if (!existsSync(summaryPath)) return { content: null, lastModified: null };
  const raw = await readFile(summaryPath, "utf-8");
  const stats = await stat(summaryPath);
  return { content: raw, lastModified: stats.mtime.toISOString() };
}

async function writeSummary(content: string): Promise<void> {
  const summaryPath = join(resolvedFolder, SUMMARY_FILE);
  await writeFile(summaryPath, content, "utf-8");
}

async function ensureHistoryDir(): Promise<string> {
  const historyDir = join(resolvedFolder, SUMMARY_HISTORY_DIR);
  if (!existsSync(historyDir)) {
    await mkdir(historyDir, { recursive: true });
  }
  return historyDir;
}

async function listVersions(): Promise<number[]> {
  const historyDir = join(resolvedFolder, SUMMARY_HISTORY_DIR);
  if (!existsSync(historyDir)) return [];
  const entries = await readdir(historyDir);
  const versions = entries
    .filter(name => /^v\d+\.md$/.test(name))
    .map(name => parseInt(name.match(/^v(\d+)\.md$/)![1], 10))
    .sort((a, b) => a - b);
  return versions;
}

async function getNextVersion(): Promise<number> {
  const versions = await listVersions();
  return versions.length === 0 ? 1 : Math.max(...versions) + 1;
}

async function saveVersion(content: string): Promise<number> {
  const historyDir = await ensureHistoryDir();
  const version = await getNextVersion();
  await writeFile(join(historyDir, `v${version}.md`), content, "utf-8");
  return version;
}

async function readVersion(version: number): Promise<{ content: string; version: number } | null> {
  const filePath = join(resolvedFolder, SUMMARY_HISTORY_DIR, `v${version}.md`);
  if (!existsSync(filePath)) return null;
  const content = await readFile(filePath, "utf-8");
  return { content, version };
}

let pendingGenerate = false;

async function generateSummary(): Promise<{ content: string; version: number }> {
  if (pendingGenerate) throw new Error("Summary generation already in progress.");
  pendingGenerate = true;

  try {
    const settings = await readSettings();
    if (!settings.apiKey) throw new Error("No API key configured");

    const context = await readContext();
    const fileList = Object.entries(context);
    if (fileList.length === 0) throw new Error("No annotations to summarize.");

    let annotationDump = "";
    for (const [filename, fileCtx] of fileList) {
      if (!fileCtx.comments || fileCtx.comments.length === 0) continue;
      annotationDump += `\n## ${filename} (status: ${fileCtx.status})\n`;
      for (let i = 0; i < fileCtx.comments.length; i++) {
        const c = fileCtx.comments[i];
        annotationDump += `- [${c.author.toUpperCase()}, #${i}] ${c.text}\n`;
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
   - To cite a comment: ["short verbatim quote"](comment:FILENAME:INDEX)
     Example: ["vitality module tracks daily energy"](comment:IMG_5210.jpeg:0)
   - To reference an image/file: [FILENAME](image:FILENAME)
     Example: [IMG_5210.jpeg](image:IMG_5210.jpeg)
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
    await writeSummary(content);
    const version = await saveVersion(content);
    return { content, version };
  } finally {
    pendingGenerate = false;
  }
}

async function listFiles(): Promise<string[]> {
  const entries = await readdir(resolvedFolder);
  return entries
    .filter((name) => {
      if (name.startsWith(".")) return false;
      if (name === CONTEXT_FILE) return false;
      if (name === SUMMARY_FILE) return false;
      const ext = extname(name).toLowerCase();
      return ALLOWED_EXTENSIONS.has(ext);
    })
    .sort();
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

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

    // API: ask Claude to analyze a file
    const askMatch = path.match(/^\/api\/files\/(.+)\/ask-claude$/);
    if (askMatch && req.method === "POST") {
      const filename = decodeURIComponent(askMatch[1]);
      try {
        const analysis = await askClaude(filename);
        // Save as a claude comment
        const context = await readContext();
        if (!context[filename]) {
          context[filename] = { comments: [], status: "pending" };
        }
        context[filename].comments.push({
          author: "claude",
          text: analysis,
          ts: new Date().toISOString(),
        });
        context[filename].status = "annotated";
        await writeContext(context);
        return json({ ok: true, text: analysis });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // API: list files with context
    if (path === "/api/files" && req.method === "GET") {
      const files = await listFiles();
      const context = await readContext();
      const result = files.map((name) => ({
        name,
        ext: extname(name).toLowerCase(),
        status: context[name]?.status ?? "pending",
        commentCount: context[name]?.comments?.length ?? 0,
      }));
      return json(result);
    }

    // API: file preview
    const previewMatch = path.match(/^\/api\/files\/(.+)\/preview$/);
    if (previewMatch && req.method === "GET") {
      const filename = decodeURIComponent(previewMatch[1]);
      const filePath = join(resolvedFolder, filename);
      if (!existsSync(filePath)) return json({ error: "Not found" }, 404);
      const ext = extname(filename).toLowerCase();
      const mime = MIME_TYPES[ext] ?? "application/octet-stream";
      const file = Bun.file(filePath);
      return new Response(file, { headers: { "Content-Type": mime } });
    }

    // API: get context
    if (path === "/api/context" && req.method === "GET") {
      const context = await readContext();
      return json(context);
    }

    // API: upload audio for a file
    const audioMatch = path.match(/^\/api\/files\/(.+)\/audio$/);
    if (audioMatch && req.method === "POST") {
      const filename = decodeURIComponent(audioMatch[1]);
      const blob = await req.blob();
      const ext = blob.type.includes("webm") ? "webm" : blob.type.includes("mp4") ? "m4a" : "ogg";
      const ts = Date.now();
      const audioFilename = `.audio_${basename(filename, extname(filename))}_${ts}.${ext}`;
      const audioPath = join(resolvedFolder, audioFilename);
      await writeFile(audioPath, Buffer.from(await blob.arrayBuffer()));
      return json({ audioFilename });
    }

    // API: serve audio file
    const audioServeMatch = path.match(/^\/api\/audio\/(.+)$/);
    if (audioServeMatch && req.method === "GET") {
      const audioFilename = decodeURIComponent(audioServeMatch[1]);
      const audioPath = join(resolvedFolder, audioFilename);
      if (!existsSync(audioPath)) return json({ error: "Not found" }, 404);
      const file = Bun.file(audioPath);
      return new Response(file, { headers: { "Content-Type": "audio/webm" } });
    }

    // API: add comment
    const commentMatch = path.match(/^\/api\/files\/(.+)\/comments$/);
    if (commentMatch && req.method === "POST") {
      const filename = decodeURIComponent(commentMatch[1]);
      const body = (await req.json()) as { author: string; text: string; audio?: string };
      if (!body.text?.trim()) return json({ error: "Empty comment" }, 400);

      const context = await readContext();
      if (!context[filename]) {
        context[filename] = { comments: [], status: "pending" };
      }
      const comment: Comment = {
        author: (body.author === "claude" ? "claude" : "user") as "user" | "claude",
        text: body.text.trim(),
        ts: new Date().toISOString(),
      };
      if (body.audio) comment.audio = body.audio;
      context[filename].comments.push(comment);
      context[filename].status = "annotated";
      await writeContext(context);
      return json(context[filename]);
    }

    // API: update status
    const statusMatch = path.match(/^\/api\/files\/(.+)\/status$/);
    if (statusMatch && req.method === "PATCH") {
      const filename = decodeURIComponent(statusMatch[1]);
      const body = (await req.json()) as { status: string };
      const validStatuses = ["pending", "annotated", "skipped"];
      if (!validStatuses.includes(body.status)) return json({ error: "Invalid status" }, 400);

      const context = await readContext();
      if (!context[filename]) {
        context[filename] = { comments: [], status: "pending" };
      }
      context[filename].status = body.status as FileContext["status"];
      await writeContext(context);
      return json(context[filename]);
    }

    // API: delete comment
    const deleteCommentMatch = path.match(/^\/api\/files\/(.+)\/comments\/(\d+)$/);
    if (deleteCommentMatch && req.method === "DELETE") {
      const filename = decodeURIComponent(deleteCommentMatch[1]);
      const index = parseInt(deleteCommentMatch[2], 10);
      const context = await readContext();
      if (!context[filename]) return json({ error: "Not found" }, 404);
      if (index < 0 || index >= context[filename].comments.length) return json({ error: "Invalid index" }, 400);
      context[filename].comments.splice(index, 1);
      if (context[filename].comments.length === 0) {
        context[filename].status = "pending";
      }
      await writeContext(context);
      return json(context[filename]);
    }

    // API: get summary
    if (path === "/api/summary" && req.method === "GET") {
      const summary = await readSummary();
      return json(summary);
    }

    // API: save summary (manual edit)
    if (path === "/api/summary" && req.method === "POST") {
      const body = (await req.json()) as { content: string };
      await writeSummary(body.content);
      return json({ ok: true });
    }

    // API: generate summary
    if (path === "/api/summary/generate" && req.method === "POST") {
      try {
        const { content, version } = await generateSummary();
        const versions = await listVersions();
        return json({ ok: true, content, version, totalVersions: versions.length });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // API: list summary versions
    if (path === "/api/summary/versions" && req.method === "GET") {
      const versions = await listVersions();
      return json({ versions, total: versions.length });
    }

    // API: get specific summary version
    const versionMatch = path.match(/^\/api\/summary\/versions\/(\d+)$/);
    if (versionMatch && req.method === "GET") {
      const versionNum = parseInt(versionMatch[1], 10);
      const result = await readVersion(versionNum);
      if (!result) return json({ error: "Version not found" }, 404);
      const versions = await listVersions();
      return json({ content: result.content, version: result.version, totalVersions: versions.length });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Context Annotator running at http://localhost:${PORT}`);
console.log(`Watching folder: ${resolvedFolder}`);
