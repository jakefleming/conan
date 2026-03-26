import { readdir, readFile, writeFile, stat, mkdir, rename as fsRename } from "fs/promises";
import { join, extname, basename, dirname, normalize } from "path";
import { existsSync } from "fs";
import sharp from "sharp";
import JSZip from "jszip";
import { ConanIndexer } from "./indexer";
import * as XLSX from "xlsx";

const ALLOWED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif",
  ".pdf", ".svg",
  ".txt", ".md", ".doc", ".docx",
  ".json", ".csv", ".tsv", ".log", ".yml", ".yaml", ".toml", ".xml",
  ".html", ".css", ".js", ".ts", ".py", ".sh",
  ".xlsx", ".xls", ".ods", ".numbers",
]);

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
  ".heif": "image/heif", ".svg": "image/svg+xml", ".pdf": "application/pdf",
  ".txt": "text/plain", ".md": "text/plain", ".log": "text/plain",
  ".json": "application/json", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".yml": "text/yaml", ".yaml": "text/yaml", ".toml": "text/plain",
  ".xml": "text/xml", ".html": "text/html", ".css": "text/css",
  ".js": "text/javascript", ".ts": "text/plain", ".py": "text/plain", ".sh": "text/plain",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel", ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".numbers": "application/x-iwork-keynote-sffnumbers",
};

const CONTEXT_FILE = ".context.json";
const SETTINGS_FILE = ".annotator-settings.json";
const SUMMARY_FILE = "SUMMARY.md";
const SUMMARY_HISTORY_DIR = ".summary-history";
const HIDDEN_DIRS = new Set([".thumbs", ".summary-history", ".git", ".DS_Store", ".attachments"]);
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

function parseImageDimensions(buffer: Buffer, ext: string): { width: number; height: number } | null {
  try {
    if (ext === ".png") {
      // PNG: width at bytes 16-19, height at bytes 20-23 (big-endian)
      if (buffer.length < 24) return null;
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }
    if (ext === ".jpg" || ext === ".jpeg") {
      // JPEG: scan for SOF0 (0xFFC0) or SOF2 (0xFFC2) marker
      let i = 2; // skip SOI marker
      while (i < buffer.length - 9) {
        if (buffer[i] !== 0xFF) { i++; continue; }
        const marker = buffer[i + 1];
        if (marker === 0xC0 || marker === 0xC2) {
          const height = buffer.readUInt16BE(i + 5);
          const width = buffer.readUInt16BE(i + 7);
          return { width, height };
        }
        // Skip to next marker using segment length
        if (marker >= 0xC0 && marker <= 0xFE && marker !== 0xD0 && marker !== 0xD1 &&
            marker !== 0xD2 && marker !== 0xD3 && marker !== 0xD4 && marker !== 0xD5 &&
            marker !== 0xD6 && marker !== 0xD7 && marker !== 0xD8 && marker !== 0xD9) {
          const segLen = buffer.readUInt16BE(i + 2);
          i += 2 + segLen;
        } else {
          i += 2;
        }
      }
      return null;
    }
    if (ext === ".gif") {
      if (buffer.length < 10) return null;
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      return { width, height };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Docx parser (uses JSZip to read the XML inside .docx) ──

const DOCX_EXTENSIONS = new Set([".docx"]);

interface DocxRun { text: string; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean }
interface DocxElement {
  type: "heading" | "paragraph" | "list-item" | "table";
  text?: string;
  runs?: DocxRun[];
  level?: number;
  align?: string;
  indent?: number;
  numType?: "ordered" | "unordered";
  listId?: number;
  rows?: { cells: { text: string; bold?: boolean }[] }[];
}

async function parseDocx(filePath: string): Promise<DocxElement[]> {
  const data = await readFile(filePath);
  const zip = await JSZip.loadAsync(data);
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("No document.xml found in .docx");

  // Parse numbering definitions to distinguish ordered vs unordered lists
  let numberingMap = new Map<string, string>(); // numId -> abstractNumId -> numFmt
  const numberingXml = await zip.file("word/numbering.xml")?.async("string");
  if (numberingXml) {
    // Map numId -> abstractNumId
    const numIdToAbstract = new Map<string, string>();
    for (const m of numberingXml.matchAll(/<w:num\s+w:numId="([^"]+)"[^>]*>[\s\S]*?<w:abstractNumId\s+w:val="([^"]+)"[\s\S]*?<\/w:num>/g)) {
      numIdToAbstract.set(m[1], m[2]);
    }
    // Map abstractNumId -> numFmt
    const abstractToFmt = new Map<string, string>();
    for (const m of numberingXml.matchAll(/<w:abstractNum\s+w:abstractNumId="([^"]+)"[\s\S]*?<\/w:abstractNum>/g)) {
      const fmtMatch = m[0].match(/<w:numFmt\s+w:val="([^"]+)"/);
      if (fmtMatch) abstractToFmt.set(m[1], fmtMatch[1]);
    }
    for (const [numId, absId] of numIdToAbstract) {
      numberingMap.set(numId, abstractToFmt.get(absId) || "bullet");
    }
  }

  const elements: DocxElement[] = [];

  // Extract table contents
  function parseTable(tableXml: string): DocxElement {
    const rows: { cells: { text: string; bold?: boolean }[] }[] = [];
    const rowMatches = tableXml.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g);
    for (const rm of rowMatches) {
      const cells: { text: string; bold?: boolean }[] = [];
      const cellMatches = rm[0].matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g);
      for (const cm of cellMatches) {
        const texts: string[] = [];
        for (const t of cm[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)) {
          texts.push(t[1]);
        }
        const bold = /<w:b[\s/>]/.test(cm[0]) && !/<w:b\s+w:val="(false|0)"/.test(cm[0]);
        cells.push({ text: texts.join(""), bold });
      }
      rows.push({ cells });
    }
    return { type: "table", rows };
  }

  // Process body - handle tables and paragraphs at top level
  const bodyMatch = docXml.match(/<w:body>([\s\S]*)<\/w:body>/);
  if (!bodyMatch) return elements;
  const body = bodyMatch[1];

  // Split body into top-level elements (tables and paragraphs)
  // We need to handle nested tags carefully
  const topLevelRegex = /<w:tbl[\s>][\s\S]*?<\/w:tbl>|<w:p[\s>][\s\S]*?<\/w:p>/g;
  let match;
  while ((match = topLevelRegex.exec(body)) !== null) {
    const chunk = match[0];

    if (chunk.startsWith("<w:tbl")) {
      elements.push(parseTable(chunk));
      continue;
    }

    // It's a paragraph
    const pXml = chunk;

    // Check for heading style
    const styleMatch = pXml.match(/<w:pStyle\s+w:val="([^"]+)"/);
    const style = styleMatch?.[1] || "";

    // Check for numbering (list item)
    const numIdMatch = pXml.match(/<w:numId\s+w:val="([^"]+)"/);
    const ilvlMatch = pXml.match(/<w:ilvl\s+w:val="([^"]+)"/);

    // Check alignment
    const alignMatch = pXml.match(/<w:jc\s+w:val="([^"]+)"/);
    const align = alignMatch?.[1] === "center" ? "center" : alignMatch?.[1] === "right" ? "right" : undefined;

    // Check indent
    const indMatch = pXml.match(/<w:ind\s+[^>]*w:left="(\d+)"/);
    const indent = indMatch ? Math.round(parseInt(indMatch[1]) / 20) : undefined; // twips to px

    // Extract runs with formatting
    const runs: DocxRun[] = [];
    const runRegex = /<w:r[\s>][\s\S]*?<\/w:r>/g;
    let runMatch;
    while ((runMatch = runRegex.exec(pXml)) !== null) {
      const rXml = runMatch[0];
      const texts: string[] = [];
      for (const t of rXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)) {
        texts.push(t[1]);
      }
      if (texts.length === 0) continue;
      const bold = /<w:b[\s/>]/.test(rXml) && !/<w:b\s+w:val="(false|0)"/.test(rXml);
      const italic = /<w:i[\s/>]/.test(rXml) && !/<w:i\s+w:val="(false|0)"/.test(rXml);
      const underline = /<w:u\s/.test(rXml) && !/<w:u\s+w:val="none"/.test(rXml);
      const strike = /<w:strike[\s/>]/.test(rXml) && !/<w:strike\s+w:val="(false|0)"/.test(rXml);
      runs.push({ text: texts.join(""), ...(bold && { bold }), ...(italic && { italic }), ...(underline && { underline }), ...(strike && { strike }) });
    }

    const fullText = runs.map(r => r.text).join("");

    // Heading
    if (/^Heading(\d)$/.test(style) || /^heading\s*(\d)$/i.test(style)) {
      const level = parseInt(style.replace(/\D/g, "")) || 1;
      elements.push({ type: "heading", level, runs, text: fullText });
    } else if (style === "Title") {
      elements.push({ type: "heading", level: 1, runs, text: fullText });
    } else if (style === "Subtitle") {
      elements.push({ type: "heading", level: 2, runs, text: fullText });
    } else if (numIdMatch) {
      // List item
      const numId = numIdMatch[1];
      const numFmt = numberingMap.get(numId) || "bullet";
      const numType = numFmt === "bullet" ? "unordered" : "ordered";
      elements.push({ type: "list-item", runs, text: fullText, numType, listId: parseInt(numId) || 0 });
    } else {
      elements.push({ type: "paragraph", runs, text: fullText, ...(align && { align }), ...(indent && { indent }) });
    }
  }

  return elements;
}

/** Extract plain text from a .docx file for indexing / Claude analysis */
async function extractDocxText(filePath: string): Promise<string> {
  const elements = await parseDocx(filePath);
  return elements.map(el => {
    if (el.type === "table") {
      return (el.rows || []).map(r => r.cells.map(c => c.text).join("\t")).join("\n");
    }
    return el.text || "";
  }).filter(Boolean).join("\n");
}

// Resize an image buffer so the base64 encoding stays under Claude's 5MB limit.
// Base64 adds ~33% overhead, so we target ~3.75MB raw.
const MAX_API_IMAGE_BYTES = 3_750_000;
async function resizeForApi(buf: Buffer, mediaType: string): Promise<Buffer> {
  if (buf.length <= MAX_API_IMAGE_BYTES) return buf;
  let img = sharp(buf);
  const meta = await img.metadata();
  let w = meta.width!;
  let h = meta.height!;
  // Progressively scale down by 70% until under limit
  while (buf.length > MAX_API_IMAGE_BYTES) {
    w = Math.round(w * 0.7);
    h = Math.round(h * 0.7);
    if (mediaType.includes("png")) {
      buf = await sharp(buf).resize(w, h).png().toBuffer();
    } else {
      buf = await sharp(buf).resize(w, h).jpeg({ quality: 85 }).toBuffer();
    }
  }
  return buf;
}

async function cropRegion(filePath: string, region: { x: number; y: number; w: number; h: number }): Promise<Buffer> {
  const metadata = await sharp(filePath).metadata();
  const imgW = metadata.width!;
  const imgH = metadata.height!;
  const cropX = Math.round((region.x / 100) * imgW);
  const cropY = Math.round((region.y / 100) * imgH);
  const cropW = Math.min(Math.round((region.w / 100) * imgW), imgW - cropX);
  const cropH = Math.min(Math.round((region.h / 100) * imgH), imgH - cropY);
  return sharp(filePath)
    .extract({ left: cropX, top: cropY, width: Math.max(1, cropW), height: Math.max(1, cropH) })
    .png()
    .toBuffer();
}

function sanitizeFilename(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9\s_-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .substring(0, 60) || 'region';
}

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

type Settings = { apiKey?: string; recentFolders?: string[] };

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

async function askClaude(relPath: string, userPrompt?: string, attachments?: any[]): Promise<string> {
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
        const attachNote = c.attachments?.length
          ? ` (references: ${c.attachments.map((a: any) => a.type === 'project' ? a.path : a.originalName).join(', ')})`
          : "";
        return `[${c.author}]${regionNote}${attachNote}: ${c.text}`;
      }).join("\n");
  }

  const messages: any[] = [];
  const content: any[] = [];
  const isText = TEXT_EXTENSIONS.has(ext);
  const isPdf = ext === ".pdf";
  const isDocx = DOCX_EXTENSIONS.has(ext);

  if (isImage) {
    const imageDataRaw = await readFile(filePath);
    const mediaType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
    const imageData = await resizeForApi(Buffer.from(imageDataRaw), mediaType);
    const base64 = imageData.toString("base64");
    content.push({
      type: "image",
      source: { type: "base64", media_type: mediaType, data: base64 },
    });
  } else if (isPdf) {
    // Send PDF as a document block
    const pdfData = Buffer.from(await readFile(filePath));
    if (pdfData.length < 30 * 1024 * 1024) {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdfData.toString("base64") },
      });
    }
  } else if (isDocx) {
    // Extract text from Word document
    try {
      const docxText = await extractDocxText(filePath);
      content.push({
        type: "text",
        text: `--- Word document content of "${base}" ---\n${docxText.slice(0, MAX_DOC_SIZE)}\n--- End of document ---`,
      });
    } catch {}
  } else if (isText) {
    // Include the text file content directly
    const textContent = await readFile(filePath, "utf-8");
    content.push({
      type: "text",
      text: `--- File content of "${base}" ---\n${textContent.slice(0, MAX_DOC_SIZE)}\n--- End of file ---`,
    });
  }

  const userPromptSection = userPrompt
    ? `\n\nThe user is specifically asking: "${userPrompt}"`
    : "";

  let fileTypeInstruction = "";
  if (isImage) {
    fileTypeInstruction = "Look at this image carefully. Read ALL handwritten text, labels, arrows, and diagram elements.";
  } else if (isPdf) {
    fileTypeInstruction = "Read this PDF document carefully. Analyze its full content including text, tables, and any embedded images.";
  } else if (isDocx) {
    fileTypeInstruction = "Read this Word document carefully. Analyze its full content, structure, formatting, and key information.";
  } else if (isText) {
    fileTypeInstruction = "Read this text document carefully. Analyze its full content, structure, and key information.";
  } else {
    fileTypeInstruction = `This is a ${ext} file.`;
  }

  content.push({
    type: "text",
    text: `You are a technical analyst reviewing a file called "${base}" that was captured during an in-person product/design session. The user has already provided voice annotations with their own context about what this file contains.${existingContext}${userPromptSection}

${fileTypeInstruction}

${userPrompt ? `Focus your response on answering the user's question/request: "${userPrompt}". Be direct and specific.` : `Your job is to ADD VALUE beyond what the user already said. Follow these rules strictly:
1. Start with "Implementation notes from reviewing ${isImage ? "sketch" : "document"} + user context:" (or similar)
2. Use a numbered list. Keep each point to 2-3 sentences max.
3. First, identify any specific ${isImage ? "text, labels, UI elements, or details visible in the image" : "information, decisions, action items, or key points in the document"} that the user did NOT mention.
4. Then add implementation notes: what does this mean for the codebase? What data models, APIs, or components does this imply?
5. Flag any ambiguities or open questions worth clarifying with the team.
6. Do NOT repeat what the user already said. Do NOT give generic advice about HIPAA, competitive analysis, or best practices unless directly relevant to something in the ${isImage ? "image" : "document"}.
7. Do NOT use bold/header markdown formatting. Plain text with numbered points only.
8. Keep it under 400 words. Be specific and actionable, not generic.`}`,
  });

  // Process user-attached images
  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      try {
        let imageBuffer: Buffer;
        let mediaType: string;
        let label: string;
        if (att.type === "project") {
          const attPath = safePath(att.path);
          const attExt = extname(att.path).toLowerCase();
          mediaType = attExt === ".png" ? "image/png" : attExt === ".gif" ? "image/gif" : attExt === ".webp" ? "image/webp" : "image/jpeg";
          let rawBuffer: Buffer;
          if (att.region && typeof att.region.x === "number") {
            rawBuffer = await cropRegion(attPath, att.region);
            mediaType = "image/png";
          } else {
            rawBuffer = Buffer.from(await readFile(attPath));
          }
          imageBuffer = await resizeForApi(rawBuffer, mediaType);
          label = att.region ? `${att.path} (crop)` : att.path;
        } else if (att.type === "upload") {
          mediaType = att.mediaType || "image/png";
          imageBuffer = await resizeForApi(Buffer.from(att.data, "base64"), mediaType);
          label = att.name || "uploaded image";
        } else continue;
        content.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data: imageBuffer.toString("base64") },
        });
        content.push({ type: "text", text: `[Attached by user: ${label}]` });
      } catch (e: any) {
        content.push({ type: "text", text: `[Failed to load attachment: ${e.message}]` });
      }
    }
  }

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

  const imageDataRaw = await readFile(filePath);
  const mediaType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const imageData = await resizeForApi(Buffer.from(imageDataRaw), mediaType);
  const base64 = imageData.toString("base64");

  // Parse image dimensions from file headers (use original for accurate dims)
  const dims = parseImageDimensions(imageDataRaw, ext);
  const dimsInfo = dims ? `\n\nImage dimensions: ${dims.width}×${dims.height} pixels (aspect ratio ${dims.width > dims.height ? 'landscape' : dims.height > dims.width * 1.5 ? 'tall/portrait' : 'portrait'}).` : "";

  const messages = [{
    role: "user",
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: mediaType, data: base64 },
      },
      {
        type: "text",
        text: `You are analyzing a photo from a product/design session.${existingContext}${dimsInfo}

Your task: identify distinct text, labels, diagram elements, or visual notes in this image and provide tight bounding boxes for each.

IMPORTANT — Spatial reasoning steps (you MUST do this before outputting coordinates):
1. Mentally divide the image into a 10×10 grid. Column 1 = leftmost 10% (x: 0-10), Column 10 = rightmost 10% (x: 90-100). Row 1 = topmost 10% (y: 0-10), Row 10 = bottommost 10% (y: 90-100).
2. For EACH element you find, first determine which grid cell(s) it occupies. For example, a title at the very top-left would be in cells (col 1-3, row 1).
3. THEN convert grid positions to percentage coordinates.

Calibration guide:
- An element at the very top of the image → y should be 0-5
- An element at the very bottom → y should be 90-100
- An element at the far left → x should be 0-10
- An element centered horizontally → x should be ~35-45 with w ~15-25
- The vertical midpoint of the image is y=50. Content in the upper half MUST have y < 50.

Output format — return a JSON array wrapped in <annotations> tags:
<annotations>[{"grid":"cols 1-4, rows 1-2","region":{"x":N,"y":N,"w":N,"h":N},"text":"description"}]</annotations>

The "grid" field is your reasoning about which grid cells the element occupies. The "region" field has the precise percentage coordinates derived from that grid reasoning.

Coordinate rules:
- x, y, w, h are percentages (0-100) of the FULL image width and height
- x,y = top-left corner of the bounding box
- w,h = width and height of the bounding box
- Boxes should be TIGHT — just big enough to contain the element
- Typical box width: 5-30% of image width. Typical box height: 2-10% of image height.

Content rules:
- Maximum 8 annotations
- Skip areas already covered by existing comments
- For text: transcribe it. For diagrams/arrows: briefly describe them.
- One element per annotation — do not group multiple items into one large box
- IGNORE faint text bleeding through from the back of paper
- NEVER start descriptions with "This cropped region shows" or similar preamble. Jump straight into the substance.`,
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

  // Extract JSON array from response — try <annotations> tags first, then fall back to raw JSON
  const tagMatch = rawText.match(/<annotations>([\s\S]*?)<\/annotations>/);
  const jsonMatch = tagMatch ? tagMatch[1].match(/\[[\s\S]*\]/) : rawText.match(/\[[\s\S]*\]/);
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

let resolvedFolder = targetFolder.startsWith("/")
  ? targetFolder
  : join(process.cwd(), targetFolder);

if (!existsSync(resolvedFolder)) {
  console.error(`Folder not found: ${resolvedFolder}`);
  process.exit(1);
}

// Initialize the indexer
const indexer = new ConanIndexer(resolvedFolder);

// Wire up real-time move detection callback
indexer.onFileMoved = async (oldRelPath: string, newRelPath: string, hash: string) => {
  const { dir: oldDir, base: oldName } = splitRelPath(oldRelPath);
  const { dir: newDir, base: newName } = splitRelPath(newRelPath);
  // Read old context, migrate entry to new location
  const oldContext = await readContext(oldDir);
  if (oldContext[oldName]) {
    const entry = oldContext[oldName];
    delete oldContext[oldName];
    await writeContext(oldContext, oldDir);
    const newContext = await readContext(newDir);
    newContext[newName] = { ...entry, hash };
    await writeContext(newContext, newDir);
    console.log(`Context migrated: ${oldRelPath} → ${newRelPath}`);
    // Update attachment references across all .context.json files
    async function updateRefsForMove(dir: string, relPath: string) {
      const ctx = await readContext(relPath);
      let changed = false;
      for (const [, e] of Object.entries(ctx)) {
        for (const c of (e.comments || [])) {
          if (!c.attachments) continue;
          for (const att of c.attachments) {
            if (att.type === "project" && att.path === oldRelPath) {
              att.path = newRelPath;
              changed = true;
            }
          }
        }
      }
      if (changed) await writeContext(ctx, relPath);
      const entries = await readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith(".") || HIDDEN_DIRS.has(ent.name)) continue;
        await updateRefsForMove(join(dir, ent.name), relPath ? `${relPath}/${ent.name}` : ent.name);
      }
    }
    await updateRefsForMove(resolvedFolder, "");
    // Track for UI notification
    if (!lastReconcileResult) {
      lastReconcileResult = { migrated: [], stillOrphaned: 0, ts: new Date().toISOString() };
    }
    lastReconcileResult.migrated.push({ from: oldRelPath, to: newRelPath, filename: newName });
    lastReconcileResult.ts = new Date().toISOString();
    // Record alias + flatten chain (update any old aliases pointing to the old name)
    try {
      const now = new Date().toISOString();
      indexer.db.prepare("UPDATE file_aliases SET new_path = ?, renamed_at = ? WHERE new_path = ?").run(newRelPath, now, oldRelPath);
      indexer.db.prepare("INSERT INTO file_aliases (old_path, new_path, renamed_at) VALUES (?, ?, ?)").run(oldRelPath, newRelPath, now);
    } catch (e) { /* ignore */ }
  }
};

// Start background indexing + hash backfill + auto-reconcile
(async () => {
  const settings = await readSettings();
  if (settings.apiKey) indexer.setApiKey(settings.apiKey);

  // Phase 1: Backfill hashes for all files
  console.log("Backfilling file hashes...");
  const hashCount = await backfillAllHashes();
  if (hashCount > 0) console.log(`Backfilled ${hashCount} file hashes`);

  // Phase 2: Auto-reconcile moved/renamed files
  console.log("Checking for moved/renamed files...");
  const reconcileResult = await reconcileAll();
  if (reconcileResult.migrated.length > 0) {
    console.log(`Auto-reconciled ${reconcileResult.migrated.length} moved/renamed file(s):`);
    for (const m of reconcileResult.migrated) console.log(`  ${m.from} → ${m.to}`);
    lastReconcileResult = { ...reconcileResult, ts: new Date().toISOString() };
  }
  if (reconcileResult.stillOrphaned > 0) {
    console.log(`${reconcileResult.stillOrphaned} orphaned annotation(s) remain (no matching files found)`);
  }

  // Flatten alias chains: if A→B and B→C exist, update A→C
  try {
    const stale = indexer.db.prepare(`
      SELECT a1.id, a1.old_path, a2.new_path AS final_path
      FROM file_aliases a1
      JOIN file_aliases a2 ON a1.new_path = a2.old_path
      WHERE a1.new_path != a2.new_path
    `).all() as any[];
    for (const s of stale) {
      indexer.db.prepare("UPDATE file_aliases SET new_path = ?, renamed_at = ? WHERE id = ?").run(s.final_path, new Date().toISOString(), s.id);
    }
    if (stale.length > 0) console.log(`Flattened ${stale.length} alias chain(s)`);
  } catch (e) { /* ignore */ }

  // Index scan
  console.log("Starting initial index scan...");
  const result = await indexer.fullScan();
  console.log(`Index scan complete: ${result.indexed} indexed, ${result.skipped} unchanged, ${result.removed} removed`);
  indexer.startWatcher();
  if (settings.apiKey) indexer.processExtractionQueue();
})();

type Region = { x: number; y: number; w: number; h: number };
type CommentAttachment =
  | { type: "project"; path: string }
  | { type: "local"; path: string; originalName: string };
type Comment = { author: "user" | "claude"; text: string; ts: string; audio?: string; region?: Region; attachments?: CommentAttachment[] };
type FileContext = { comments: Comment[]; status: "pending" | "annotated" | "skipped"; hash?: string };
type ContextData = Record<string, FileContext>;

// Per-directory write lock to prevent concurrent read-modify-write races on .context.json
const contextLocks = new Map<string, Promise<void>>();

function withContextLock<T>(subdir: string, fn: () => Promise<T>): Promise<T> {
  const key = subdir || "__root__";
  const prev = contextLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn); // run fn after previous completes (even if it failed)
  contextLocks.set(key, next.then(() => {}, () => {})); // swallow errors in the chain
  return next;
}

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

/** Locked read-modify-write: reads context, calls mutator, writes back. Prevents concurrent clobbering. */
async function updateContext(subdir: string, mutator: (ctx: ContextData) => void | Promise<void>): Promise<ContextData> {
  return withContextLock(subdir, async () => {
    const ctx = await readContext(subdir);
    await mutator(ctx);
    await writeContext(ctx, subdir);
    return ctx;
  });
}

/** Backfill hashes for ALL files in a directory (not just annotated ones) */
async function backfillHashes(subdir: string = ""): Promise<number> {
  const dirPath = join(resolvedFolder, subdir);
  if (!existsSync(dirPath)) return 0;
  const context = await readContext(subdir);
  let modified = false;
  let count = 0;

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || HIDDEN_DIRS.has(e.name)) continue;
      if (e.isDirectory()) continue;
      const ext = extname(e.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;
      // Create entry if missing, backfill hash if missing
      if (!context[e.name]) {
        context[e.name] = { comments: [], status: "pending" };
      }
      if (!context[e.name].hash) {
        try {
          context[e.name].hash = await computeFileHash(join(dirPath, e.name));
          modified = true;
          count++;
        } catch {}
      }
    }
    if (modified) await writeContext(context, subdir);
  } catch {}
  return count;
}

/** Recursively backfill hashes for entire project tree */
async function backfillAllHashes(): Promise<number> {
  let total = 0;
  async function walk(dir: string, relPath: string) {
    total += await backfillHashes(relPath);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".") || HIDDEN_DIRS.has(e.name)) continue;
        const childRel = relPath ? `${relPath}/${e.name}` : e.name;
        await walk(join(dir, e.name), childRel);
      }
    } catch {}
  }
  await walk(resolvedFolder, "");
  return total;
}

// Store last reconciliation results for UI notifications
let lastReconcileResult: { migrated: { from: string; to: string; filename: string }[]; stillOrphaned: number; ts: string } | null = null;

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

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv", ".tsv", ".xml", ".yaml", ".yml", ".toml", ".ini", ".log", ".html", ".css", ".js", ".ts", ".py", ".rb", ".sh", ".sql", ".rtf"]);
const MAX_DOC_SIZE = 50000; // 50KB per document to avoid blowing up the prompt

async function collectTextDocuments(dir: string, relPath: string, recursive: boolean = false): Promise<{ path: string; content: string }[]> {
  const results: { path: string; content: string }[] = [];
  const absDir = join(resolvedFolder, relPath);
  try {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const ext = extname(entry.name).toLowerCase();
      if (entry.isFile() && TEXT_EXTENSIONS.has(ext)) {
        // Skip SUMMARY.md — that's our own output
        if (entry.name === "SUMMARY.md") continue;
        try {
          const filePath = join(absDir, entry.name);
          const content = await readFile(filePath, "utf-8");
          const displayPath = relPath ? `${relPath}/${entry.name}` : entry.name;
          results.push({ path: displayPath, content: content.slice(0, MAX_DOC_SIZE) });
        } catch {}
      }
      if (recursive && entry.isDirectory() && !HIDDEN_DIRS.has(entry.name)) {
        const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
        results.push(...await collectTextDocuments(join(absDir, entry.name), childRel, true));
      }
    }
  } catch {}
  return results;
}

// Collect thumbnail images as base64 for multimodal API calls.
// Returns image content blocks ready for the Claude API, plus a list of filenames included.
async function collectThumbnails(
  subdir: string,
  recursive: boolean = false
): Promise<{ blocks: any[]; fileNames: string[] }> {
  const blocks: any[] = [];
  const fileNames: string[] = [];

  async function scanDir(absDir: string, relPath: string) {
    try {
      const entries = await readdir(absDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || HIDDEN_DIRS.has(entry.name)) continue;
        if (entry.isDirectory()) {
          if (recursive) {
            const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
            await scanDir(join(absDir, entry.name), childRel);
          }
          continue;
        }
        const ext = extname(entry.name).toLowerCase();
        const displayName = relPath ? `${relPath}/${entry.name}` : entry.name;

        // Handle PDFs
        if (ext === ".pdf") {
          try {
            const filePath = join(absDir, entry.name);
            const pdfData = Buffer.from(await readFile(filePath));
            // Claude API max PDF size ~32MB; skip very large ones
            if (pdfData.length < 30 * 1024 * 1024) {
              blocks.push({ type: "text", text: `[PDF: ${displayName}]` });
              blocks.push({
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: pdfData.toString("base64"),
                },
              });
              fileNames.push(displayName);
            }
          } catch {}
          continue;
        }

        if (!IMAGE_EXTENSIONS.has(ext)) continue;

        const thumbDir = join(absDir, ".thumbs");
        const thumbPath = join(thumbDir, `${basename(entry.name, ext)}.jpg`);

        let imageData: Buffer | null = null;
        let mediaType = "image/jpeg";

        if (existsSync(thumbPath)) {
          imageData = Buffer.from(await readFile(thumbPath));
        } else {
          // Generate thumbnail on-the-fly
          const filePath = join(absDir, entry.name);
          if (!existsSync(thumbDir)) await mkdir(thumbDir, { recursive: true });
          const proc = Bun.spawnSync([
            "sips", "-s", "format", "jpeg", "-s", "formatOptions", "70",
            "-Z", "400", filePath, "--out", thumbPath,
          ]);
          if (proc.exitCode === 0 && existsSync(thumbPath)) {
            imageData = Buffer.from(await readFile(thumbPath));
          }
        }

        if (imageData) {
          // Add a text label before the image
          blocks.push({ type: "text", text: `[Image: ${displayName}]` });
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: imageData.toString("base64"),
            },
          });
          fileNames.push(displayName);
        }
      }
    } catch {}
  }

  const absDir = join(resolvedFolder, subdir);
  await scanDir(absDir, subdir);
  return { blocks, fileNames };
}

async function generateSummary(subdir: string = "", aggregate: boolean = false): Promise<{ content: string; version: number }> {
  if (pendingGenerate) throw new Error("Summary generation already in progress.");
  pendingGenerate = true;

  try {
    const settings = await readSettings();
    if (!settings.apiKey) throw new Error("No API key configured");

    let annotationDump = "";

    if (aggregate) {
      // Collect all files (annotated + unannotated) across all directories
      const allContexts = await collectAllContexts(join(resolvedFolder, subdir), subdir);
      // Also scan for unannotated files in all directories
      async function collectAllFiles(absDir: string, relPath: string): Promise<{ dir: string; filename: string }[]> {
        const result: { dir: string; filename: string }[] = [];
        const { files } = await listFiles(relPath);
        for (const f of files) result.push({ dir: relPath, filename: f });
        const entries = await readdir(absDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".") || HIDDEN_DIRS.has(entry.name)) continue;
          const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
          result.push(...await collectAllFiles(join(absDir, entry.name), childRel));
        }
        return result;
      }
      const allFiles = await collectAllFiles(join(resolvedFolder, subdir), subdir);
      const annotatedSet = new Set(allContexts.map(c => `${c.dir}/${c.filename}`));

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
      // Add unannotated files
      for (const { dir, filename } of allFiles) {
        const key = `${dir}/${filename}`;
        if (!annotatedSet.has(key)) {
          const displayName = dir ? `${dir}/${filename}` : filename;
          annotationDump += `\n## ${displayName} (status: pending) — no annotations\n`;
        }
      }
      if (allContexts.length === 0 && allFiles.length === 0) throw new Error("No files to summarize.");
    } else {
      const context = await readContext(subdir);
      const { files } = await listFiles(subdir);
      // Include ALL files — annotated and unannotated
      for (const filename of files) {
        const fileCtx = context[filename];
        const displayName = subdir ? `${subdir}/${filename}` : filename;
        if (fileCtx && fileCtx.comments && fileCtx.comments.length > 0) {
          annotationDump += `\n## ${displayName} (status: ${fileCtx.status})\n`;
          for (let i = 0; i < fileCtx.comments.length; i++) {
            const c = fileCtx.comments[i];
            const regionNote = c.region
              ? ` (region: ${Math.round(c.region.x)}%-${Math.round(c.region.x + c.region.w)}% x, ${Math.round(c.region.y)}%-${Math.round(c.region.y + c.region.h)}% y)`
              : "";
            const attNote = c.attachments?.length ? ` (refs: ${c.attachments.map((a: any) => a.type === 'project' ? a.path : a.originalName).join(', ')})` : "";
            annotationDump += `- [${c.author.toUpperCase()}, #${i}]${regionNote}${attNote} ${c.text}\n`;
          }
        } else {
          annotationDump += `\n## ${displayName} (status: ${fileCtx?.status || "pending"}) — no annotations\n`;
        }
      }
      if (files.length === 0 && Object.keys(context).length === 0) throw new Error("No files to summarize.");
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
   - Every bullet point in "File-by-File Notes" and each item in "Screens and Components to Design" must include at least one comment citation.
12. If text documents (markdown, txt files) are provided alongside annotations, use them as context to enrich your summary. Reference relevant document content where it adds clarity (e.g. "per notes.md, the team decided X"). These documents are authoritative context written by the team.
13. IMAGES: Thumbnail images of the files are included alongside the annotations. Use them to fill in gaps — if an image shows UI elements, layouts, or details not captured in annotations, describe what you see. However, annotations are the PRIMARY source of truth. If an annotation says something specific about a region, trust the annotation over your visual interpretation. For unannotated images, describe what you observe and flag it as "(from image, no annotations)".`;

    // Collect text documents from the directory
    const textDocs = await collectTextDocuments(resolvedFolder, subdir, aggregate);
    let docsDump = "";
    if (textDocs.length > 0) {
      docsDump = "\n\nDOCUMENTS FOUND IN DIRECTORY:\n";
      for (const doc of textDocs) {
        docsDump += `\n### ${doc.path}\n\`\`\`\n${doc.content}\n\`\`\`\n`;
      }
    }

    // Collect thumbnails for multimodal context
    const { blocks: thumbnailBlocks } = await collectThumbnails(subdir, aggregate);

    // Build multimodal message content
    const textPrompt = `${summaryPrompt}
${docsDump ? `\nIMPORTANT: The following text documents were found alongside the images. Use them as additional context — they may contain meeting notes, requirements, project context, or domain knowledge that helps you write a better summary. Reference them where relevant.\n${docsDump}` : ""}
ANNOTATIONS:
${annotationDump}`;

    const messageContent: any[] = [{ type: "text", text: textPrompt }];
    if (thumbnailBlocks.length > 0) {
      messageContent.push({ type: "text", text: "\n\nIMAGE THUMBNAILS (for visual context — annotations take priority):" });
      messageContent.push(...thumbnailBlocks);
    }

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
        messages: [{ role: "user", content: messageContent }],
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

// Recursively list ALL files from root down
async function listAllFiles(subdir: string = ""): Promise<{ path: string; name: string; dir: string; ext: string }[]> {
  const results: { path: string; name: string; dir: string; ext: string }[] = [];
  const dirPath = join(resolvedFolder, subdir);
  if (!existsSync(dirPath)) return results;
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === CONTEXT_FILE || entry.name === SUMMARY_FILE || HIDDEN_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      const childRel = subdir ? `${subdir}/${entry.name}` : entry.name;
      results.push(...await listAllFiles(childRel));
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (ALLOWED_EXTENSIONS.has(ext)) {
        const filePath = subdir ? `${subdir}/${entry.name}` : entry.name;
        results.push({ path: filePath, name: entry.name, dir: subdir, ext });
      }
    }
  }
  return results;
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
        // Record alias so old references can be resolved
        // Also update any existing aliases that pointed to the old path → now point to new path
        try {
          const now = new Date().toISOString();
          indexer.db.prepare("UPDATE file_aliases SET new_path = ?, renamed_at = ? WHERE new_path = ?").run(toPath, now, fromPath);
          indexer.db.prepare("INSERT INTO file_aliases (old_path, new_path, renamed_at) VALUES (?, ?, ?)").run(fromPath, toPath, now);
        } catch (e) { /* table might not exist yet */ }
        orphansByHash.delete(hash);
      }
    }
  }
  await scanFiles(resolvedFolder, "");

  // 3. Update comment attachment references that point to old paths
  if (migrated.length > 0) {
    const pathMap = new Map(migrated.map(m => [m.from, m.to]));
    async function updateAttachmentRefs(dir: string, relPath: string) {
      const context = await readContext(relPath);
      let changed = false;
      for (const [, entry] of Object.entries(context)) {
        for (const comment of (entry.comments || [])) {
          if (!comment.attachments) continue;
          for (const att of comment.attachments) {
            if (att.type === "project" && pathMap.has(att.path)) {
              att.path = pathMap.get(att.path)!;
              changed = true;
            }
          }
        }
      }
      if (changed) await writeContext(context, relPath);
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".") || HIDDEN_DIRS.has(e.name)) continue;
        const childRel = relPath ? `${relPath}/${e.name}` : e.name;
        await updateAttachmentRefs(join(dir, e.name), childRel);
      }
    }
    await updateAttachmentRefs(resolvedFolder, "");
    console.log(`Updated attachment references for ${migrated.length} moved file(s)`);

    // 4. Rename audio files and update audio paths in comments
    for (const m of migrated) {
      const oldBasename = m.from.split("/").pop() || "";
      const oldNameNoExt = oldBasename.replace(/\.[^.]+$/, "");
      const newBasename = m.filename;
      const newNameNoExt = newBasename.replace(/\.[^.]+$/, "");
      const newDir = m.to.includes("/") ? m.to.substring(0, m.to.lastIndexOf("/")) : "";
      const newDirAbs = join(resolvedFolder, newDir);

      // Read the migrated entry's context to fix audio paths
      const ctx = await readContext(newDir);
      const entry = ctx[newBasename];
      if (!entry?.comments) continue;

      let ctxChanged = false;
      for (const comment of entry.comments) {
        if (!comment.audio) continue;
        const oldAudio = comment.audio;
        // Audio files are named like .audio_OLDNAME_timestamp.ogg
        const newAudio = oldAudio.replace(oldNameNoExt, newNameNoExt);
        if (newAudio !== oldAudio) {
          // Rename the actual audio file on disk
          const oldAudioPath = join(newDirAbs, oldAudio);
          const newAudioPath = join(newDirAbs, newAudio);
          if (existsSync(oldAudioPath)) {
            try {
              await fsRename(oldAudioPath, newAudioPath);
              console.log(`  Renamed audio: ${oldAudio} → ${newAudio}`);
            } catch (err) {
              console.error(`  Failed to rename audio ${oldAudio}:`, err);
            }
          } else {
            // Audio might be in the old directory if file moved across dirs
            const oldDirPath = m.from.includes("/") ? m.from.substring(0, m.from.lastIndexOf("/")) : "";
            const oldAudioAbsPath = join(resolvedFolder, oldDirPath, oldAudio);
            if (existsSync(oldAudioAbsPath)) {
              try {
                await fsRename(oldAudioAbsPath, newAudioPath);
                console.log(`  Moved+renamed audio: ${oldDirPath}/${oldAudio} → ${newDir}/${newAudio}`);
              } catch (err) {
                console.error(`  Failed to move audio ${oldAudio}:`, err);
              }
            }
          }
          comment.audio = newAudio;
          ctxChanged = true;
        }
      }
      if (ctxChanged) await writeContext(ctx, newDir);
    }
  }

  invalidateTreeCache();
  await countAllOrphans(resolvedFolder, "");
  return { migrated, stillOrphaned: totalOrphans };
}

const server = Bun.serve({
  hostname: "127.0.0.1", // localhost only — not exposed to network
  port: PORT,
  idleTimeout: 120, // Claude API calls with large images can take a while
  async fetch(req) {
    try { return await handleRequest(req); }
    catch (e: any) {
      console.error("Unhandled error:", e);
      return new Response(JSON.stringify({ error: e.message || "Internal server error" }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }
  },
});

async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const dirParam = url.searchParams.get("dir") ?? "";

    // Static files
    if (path === "/" || path === "/index.html") {
      const file = Bun.file(join(import.meta.dir, "public", "index.html"));
      return new Response(file, { headers: { "Content-Type": "text/html" } });
    }

    // Serve JS modules from public/js/
    if (path.startsWith("/js/") && path.endsWith(".js")) {
      const jsFile = Bun.file(join(import.meta.dir, "public", path));
      if (await jsFile.exists()) {
        return new Response(jsFile, { headers: { "Content-Type": "application/javascript" } });
      }
      return new Response("Not Found", { status: 404 });
    }

    // API: config
    if (path === "/api/config") {
      const settings = await readSettings();
      return json({ folder: resolvedFolder, hasApiKey: !!settings.apiKey, recentFolders: settings.recentFolders || [] });
    }

    // API: settings
    if (path === "/api/settings" && req.method === "GET") {
      const settings = await readSettings();
      return json({ hasApiKey: !!settings.apiKey });
    }
    if (path === "/api/settings" && req.method === "POST") {
      const body = (await req.json()) as { apiKey: string };
      const settings = await readSettings();
      await writeSettings({ ...settings, apiKey: body.apiKey });
      indexer.setApiKey(body.apiKey || null);
      if (body.apiKey) indexer.processExtractionQueue();
      return json({ ok: true });
    }

    // API: switch target folder
    if (path === "/api/folder/switch" && req.method === "POST") {
      const body = (await req.json()) as { folder: string };
      const newFolder = body.folder;
      if (!newFolder || !existsSync(newFolder)) return json({ error: "Folder not found" }, 400);
      // Switch the active folder
      resolvedFolder = newFolder;
      invalidateTreeCache();
      // Switch indexer to new project
      indexer.switchProject(newFolder);
      (async () => {
        const s = await readSettings();
        if (s.apiKey) indexer.setApiKey(s.apiKey);
        const result = await indexer.fullScan();
        console.log(`Index scan for new folder: ${result.indexed} indexed, ${result.skipped} unchanged, ${result.removed} removed`);
        indexer.startWatcher();
        if (s.apiKey) indexer.processExtractionQueue();
      })();
      // Add to recents
      const settings = await readSettings();
      const recents = (settings.recentFolders || []).filter((f: string) => f !== newFolder);
      recents.unshift(newFolder);
      if (recents.length > 10) recents.length = 10;
      await writeSettings({ ...settings, recentFolders: recents });
      console.log(`Switched to folder: ${resolvedFolder}`);
      return json({ folder: resolvedFolder });
    }

    // API: browse for folder using native macOS picker
    if (path === "/api/folder/browse" && req.method === "POST") {
      try {
        const proc = Bun.spawn(["osascript", "-e", 'POSIX path of (choose folder with prompt "Select project folder")'], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = await new Response(proc.stdout).text();
        const errOutput = await new Response(proc.stderr).text();
        await proc.exited;
        const selectedPath = output.trim().replace(/\/$/, ""); // remove trailing slash
        if (!selectedPath || errOutput.includes("User canceled")) {
          return json({ cancelled: true });
        }
        if (!existsSync(selectedPath)) return json({ error: "Folder not found" }, 400);
        // Switch to it
        resolvedFolder = selectedPath;
        invalidateTreeCache();
        // Switch indexer to new project
        indexer.switchProject(selectedPath);
        (async () => {
          const s = await readSettings();
          if (s.apiKey) indexer.setApiKey(s.apiKey);
          const r = await indexer.fullScan();
          console.log(`Index scan for browsed folder: ${r.indexed} indexed, ${r.skipped} unchanged, ${r.removed} removed`);
          indexer.startWatcher();
          if (s.apiKey) indexer.processExtractionQueue();
        })();
        const settings = await readSettings();
        const recents = (settings.recentFolders || []).filter((f: string) => f !== selectedPath);
        recents.unshift(selectedPath);
        if (recents.length > 10) recents.length = 10;
        await writeSettings({ ...settings, recentFolders: recents });
        console.log(`Switched to folder: ${resolvedFolder}`);
        return json({ folder: resolvedFolder });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // API: index stats
    if (path === "/api/index/stats" && req.method === "GET") {
      return json(indexer.getStats());
    }

    // API: reindex (full rebuild)
    if (path === "/api/index/reindex" && req.method === "POST") {
      try {
        const result = await indexer.reindex();
        // Re-run extraction if API key is available
        const settings = await readSettings();
        if (settings.apiKey) indexer.processExtractionQueue();
        return json(result);
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // API: search index
    if (path === "/api/index/search" && req.method === "POST") {
      try {
        const body = (await req.json()) as { query: string; filters?: any; limit?: number };
        if (!body.query) return json({ error: "query required" }, 400);
        const results = indexer.search(body.query, body.filters, body.limit || 10);
        return json({ results });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // API: find file by name or old alias (for resolving renamed/moved file refs)
    if (path === "/api/index/find-file" && req.method === "GET") {
      try {
        const q = url.searchParams.get("q") || "";
        if (!q) return json({ results: [] });
        // First check aliases (exact match on old_path)
        const aliasStmt = indexer.db.prepare("SELECT new_path FROM file_aliases WHERE old_path = ? ORDER BY renamed_at DESC LIMIT 1");
        const alias = aliasStmt.get(q) as any;
        if (alias) return json({ results: [{ file_path: alias.new_path, file_name: alias.new_path.split("/").pop() }] });
        // Also try matching just the filename part of old_path
        const aliasStmt2 = indexer.db.prepare("SELECT new_path FROM file_aliases WHERE old_path LIKE ? ORDER BY renamed_at DESC LIMIT 1");
        const alias2 = aliasStmt2.get(`%${q}`) as any;
        if (alias2) return json({ results: [{ file_path: alias2.new_path, file_name: alias2.new_path.split("/").pop() }] });
        // Fall back to partial filename match in files table
        const stmt = indexer.db.prepare("SELECT file_path AS file_path, file_name AS file_name FROM files WHERE file_name LIKE ? LIMIT 5");
        const results = stmt.all(`%${q}%`);
        return json({ results });
      } catch (e: any) {
        return json({ results: [] });
      }
    }

    // API: directory tree
    if (path === "/api/tree" && req.method === "GET") {
      const tree = await getTree();
      return json(tree);
    }

    // API: list all files recursively from root
    if (path === "/api/files-all" && req.method === "GET") {
      const allFiles = await listAllFiles();
      return json(allFiles);
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
        lastReconcileResult = { ...result, ts: new Date().toISOString() };
        return json(result);
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // API: get last reconcile result (for UI notification)
    if (path === "/api/reconcile/last" && req.method === "GET") {
      if (lastReconcileResult) {
        const result = lastReconcileResult;
        lastReconcileResult = null; // consume it
        return json(result);
      }
      return json(null);
    }

    // API: rename a file (preserving context)
    const renameMatch = path.match(/^\/api\/files\/(.+)\/rename$/);
    if (renameMatch && req.method === "PUT") {
      const relPath = decodeURIComponent(renameMatch[1]);
      const { dir, base: oldName } = splitRelPath(relPath);
      try { safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      const body = (await req.json()) as { newName: string };
      const newName = body.newName?.trim();
      if (!newName || newName.includes("/") || newName.includes("\\")) {
        return json({ error: "Invalid filename" }, 400);
      }
      const oldPath = join(resolvedFolder, dir, oldName);
      const newPath = join(resolvedFolder, dir, newName);
      if (!existsSync(oldPath)) return json({ error: "File not found" }, 404);
      if (existsSync(newPath)) return json({ error: "A file with that name already exists" }, 409);

      try {
        // 1. Rename the physical file
        await fsRename(oldPath, newPath);
        // 2. Migrate context entry
        const context = await readContext(dir);
        if (context[oldName]) {
          context[newName] = { ...context[oldName] };
          // Update hash for renamed file
          try { context[newName].hash = await computeFileHash(newPath); } catch {}
          delete context[oldName];
          await writeContext(context, dir);
        }
        // 3. Rename thumbnail if it exists
        const ext = extname(oldName).toLowerCase();
        const oldThumb = join(resolvedFolder, dir, ".thumbs", `${basename(oldName, ext)}.jpg`);
        const newThumb = join(resolvedFolder, dir, ".thumbs", `${basename(newName, extname(newName).toLowerCase())}.jpg`);
        if (existsSync(oldThumb)) {
          try { await fsRename(oldThumb, newThumb); } catch {}
        }
        // 4. Update SQLite index
        const oldRelPath = dir ? `${dir}/${oldName}` : oldName;
        const newRelPath = dir ? `${dir}/${newName}` : newName;
        try {
          indexer.renameFile(oldRelPath, newRelPath);
        } catch {}
        invalidateTreeCache();
        return json({ ok: true, newPath: newRelPath });
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
        let userPrompt: string | undefined;
        let attachments: any[] | undefined;
        try {
          const body = await req.json();
          if (body?.prompt) userPrompt = body.prompt;
          if (body?.attachments) attachments = body.attachments;
        } catch {}
        const analysis = await askClaude(relPath, userPrompt, attachments);
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

    // API: describe-region — Claude describes what's in a user-drawn region
    const describeRegionMatch = path.match(/^\/api\/files\/(.+)\/describe-region$/);
    if (describeRegionMatch && req.method === "POST") {
      const relPath = decodeURIComponent(describeRegionMatch[1]);
      const { dir, base } = splitRelPath(relPath);
      try {
        safePath(relPath);
        const body = await req.json() as any;
        const region = body.region;
        if (!region || typeof region.x !== "number" || typeof region.y !== "number" ||
            typeof region.w !== "number" || typeof region.h !== "number") {
          return json({ error: "Missing or invalid region" }, 400);
        }

        const settings = await readSettings();
        if (!settings.apiKey) return json({ error: "No API key configured" }, 400);

        const filePath = safePath(relPath);
        const ext = extname(base).toLowerCase();
        if (!IMAGE_EXTENSIONS.has(ext)) return json({ error: "Only images supported" }, 400);

        // Crop the image to the region
        const croppedBufferRaw = await cropRegion(filePath, region);
        const croppedBuffer = await resizeForApi(croppedBufferRaw, "image/png");
        const croppedBase64 = croppedBuffer.toString("base64");

        // Also send the full image for context (resized if needed)
        const fullMediaType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
        const fullImageRaw = await readFile(filePath);
        const fullImageResized = await resizeForApi(Buffer.from(fullImageRaw), fullMediaType);
        const fullBase64 = fullImageResized.toString("base64");

        // Build existing comments context
        const context = await readContext(dir);
        const fileCtx = context[base];
        let existingContext = "";
        if (fileCtx?.comments?.length) {
          existingContext = "\n\nExisting comments on this file:\n" +
            fileCtx.comments.map((c: any) => `[${c.author}]: ${c.text}`).join("\n");
        }

        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": settings.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 512,
            messages: [{
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Here is the full image for context:",
                },
                {
                  type: "image",
                  source: { type: "base64", media_type: fullMediaType, data: fullBase64 },
                },
                {
                  type: "text",
                  text: "Now here is the specific cropped region the user selected:",
                },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: croppedBase64 },
                },
                {
                  type: "text",
                  text: `Describe what's in the cropped region. Use the full image for context (e.g. what app/screen/document this is from), but focus your description on the cropped region specifically. Be concise — 1-2 sentences.${existingContext}

Focus on:
- If there's text: transcribe it and explain its context
- If there's a diagram, UI element, or sketch: describe what it shows and its role in the larger image

NEVER start with "This cropped region shows" or similar preamble. Jump straight into the substance — name the element, transcribe the text, or describe the action. For example: "Personalized nutrient plan with 5 supplement sliders..." not "This cropped region shows a personalized nutrient plan..."

Return ONLY your description, no labels or prefixes.`,
                },
              ],
            }],
          }),
        });

        if (!res.ok) {
          const err = await res.text();
          return json({ error: `Claude API error: ${res.status} ${err}` }, 500);
        }

        const data = await res.json() as any;
        const text = (data.content[0]?.text ?? "").trim();

        // Save as a claude comment with the region
        if (!context[base]) {
          context[base] = { comments: [], status: "pending" };
        }
        context[base].comments.push({
          author: "claude",
          text,
          ts: new Date().toISOString(),
          region,
        });
        context[base].status = "annotated";
        await writeContext(context, dir);

        return json({ ok: true, text });
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

        // Backfill hashes for ALL files in this directory
        let contextModified = false;
        for (const name of fileNames) {
          if (!context[name]) context[name] = { comments: [], status: "pending" };
          if (!context[name].hash) {
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
          const subListing = await listFiles(subPath);
          const fileCount = subListing.files.length;
          const dirCount = subListing.directories.length;
          const annotatedCount = Object.values(subCtx).filter(f => f.status === "annotated").length;
          dirEntries.push({
            type: "directory" as const,
            name: dirName,
            path: subPath,
            fileCount,
            dirCount,
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

    // API: serve a cropped region as PNG
    const cropMatch = path.match(/^\/api\/files\/(.+)\/crop$/);
    if (cropMatch && req.method === "GET") {
      const relPath = decodeURIComponent(cropMatch[1]);
      try {
        const filePath = safePath(relPath);
        if (!existsSync(filePath)) return json({ error: "Not found" }, 404);
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const x = parseFloat(url.searchParams.get("x") || "0");
        const y = parseFloat(url.searchParams.get("y") || "0");
        const w = parseFloat(url.searchParams.get("w") || "100");
        const h = parseFloat(url.searchParams.get("h") || "100");
        const buf = await cropRegion(filePath, { x, y, w, h });
        return new Response(buf, {
          headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" },
        });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
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

    // API: spreadsheet data (parsed JSON for table rendering)
    const spreadsheetMatch = path.match(/^\/api\/files\/(.+)\/spreadsheet$/);
    if (spreadsheetMatch && req.method === "GET") {
      const relPath = decodeURIComponent(spreadsheetMatch[1]);
      let filePath: string;
      try { filePath = safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      if (!existsSync(filePath)) return json({ error: "Not found" }, 404);

      try {
        const fileStat = await stat(filePath);
        if (fileStat.size > 20_000_000) return json({ error: "File too large (>20MB)" }, 400);

        const buffer = await readFile(filePath);
        const workbook = XLSX.read(buffer, { type: "buffer" });
        const MAX_ROWS = 500;

        const sheets = workbook.SheetNames.map(name => {
          const sheet = workbook.Sheets[name];
          const rows: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as string[][];
          const totalRows = rows.length;
          const headers = rows.length > 0 ? rows[0] : [];
          const dataRows = rows.slice(1, MAX_ROWS + 1);
          const truncated = totalRows - 1 > MAX_ROWS;

          // Get column widths from sheet
          const colWidths = (sheet["!cols"] || []).map((c: any) => c?.wpx || c?.wch ? (c.wch || 10) * 8 : 100);

          return { name, headers, rows: dataRows, totalRows: totalRows - 1, truncated, colWidths };
        });

        return json({ sheets, activeSheet: 0 });
      } catch (e: any) {
        if (e.message?.includes("password")) {
          return json({ error: "Password-protected file" }, 400);
        }
        return json({ error: `Failed to parse spreadsheet: ${e.message}` }, 500);
      }
    }

    // API: parse .docx and return structured content
    const docxMatch = path.match(/^\/api\/files\/(.+)\/docx$/);
    if (docxMatch && req.method === "GET") {
      const relPath = decodeURIComponent(docxMatch[1]);
      let filePath: string;
      try { filePath = safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      if (!existsSync(filePath)) return json({ error: "Not found" }, 404);

      try {
        const elements = await parseDocx(filePath);
        return json({ elements });
      } catch (e: any) {
        return json({ error: `Failed to parse document: ${e.message}` }, 500);
      }
    }

    // API: reveal file in Finder
    const revealMatch = path.match(/^\/api\/files\/(.+)\/reveal$/);
    if (revealMatch && req.method === "POST") {
      const relPath = decodeURIComponent(revealMatch[1]);
      let filePath: string;
      try { filePath = safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      if (!existsSync(filePath)) return json({ error: "Not found" }, 404);
      Bun.spawn(["open", "-R", filePath]);
      return json({ ok: true });
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

    // API: upload external file to .attachments/
    if (path === "/api/attachments/upload" && req.method === "POST") {
      try {
        const body = (await req.json()) as { dir?: string; data: string; name: string; mediaType?: string };
        if (!body.data || !body.name) return json({ error: "data and name required" }, 400);
        const dir = body.dir || "";
        const attDir = join(resolvedFolder, dir, ".attachments");
        await mkdir(attDir, { recursive: true });
        // Sanitize filename and make unique
        const safeName = body.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const uniqueName = `${Date.now()}_${safeName}`;
        const filePath = join(attDir, uniqueName);
        const buffer = Buffer.from(body.data, "base64");
        await writeFile(filePath, buffer);
        const relPath = dir ? `${dir}/.attachments/${uniqueName}` : `.attachments/${uniqueName}`;
        return json({ path: relPath, originalName: body.name });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // API: serve attachment file
    const attServeMatch = path.match(/^\/api\/attachments\/(.+)$/);
    if (attServeMatch && req.method === "GET") {
      const relPath = decodeURIComponent(attServeMatch[1]);
      const filePath = join(resolvedFolder, relPath);
      if (!filePath.startsWith(resolvedFolder) || !existsSync(filePath)) return json({ error: "Not found" }, 404);
      const ext = extname(relPath).toLowerCase();
      const mime = MIME_TYPES[ext] ?? "application/octet-stream";
      const file = Bun.file(filePath);
      return new Response(file, { headers: { "Content-Type": mime } });
    }

    // API: add comment
    const commentMatch = path.match(/^\/api\/files\/(.+)\/comments$/);
    if (commentMatch && req.method === "POST") {
      const relPath = decodeURIComponent(commentMatch[1]);
      const { dir, base } = splitRelPath(relPath);
      try { safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      const body = (await req.json()) as { author: string; text: string; audio?: string; region?: Region; attachments?: CommentAttachment[] };
      if (!body.text?.trim() && (!body.attachments || body.attachments.length === 0)) return json({ error: "Empty comment" }, 400);

      const comment: Comment = {
        author: (body.author === "claude" ? "claude" : "user") as "user" | "claude",
        text: (body.text || "").trim(),
        ts: new Date().toISOString(),
      };
      if (body.audio) comment.audio = body.audio;
      if (body.region) comment.region = body.region;
      if (body.attachments && body.attachments.length > 0) comment.attachments = body.attachments;
      const ctx = await updateContext(dir, async (context) => {
        if (!context[base]) context[base] = { comments: [], status: "pending" };
        if (!context[base].hash) {
          try { context[base].hash = await computeFileHash(join(resolvedFolder, relPath)); } catch {}
        }
        context[base].comments.push(comment);
        context[base].status = "annotated";
      });
      return json(ctx[base]);
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

      const ctx = await updateContext(dir, (context) => {
        if (!context[base]) context[base] = { comments: [], status: "pending" };
        context[base].status = body.status as FileContext["status"];
      });
      return json(ctx[base]);
    }

    // API: delete comment
    const deleteCommentMatch = path.match(/^\/api\/files\/(.+)\/comments\/(\d+)$/);
    if (deleteCommentMatch && req.method === "DELETE") {
      const relPath = decodeURIComponent(deleteCommentMatch[1]);
      const { dir, base } = splitRelPath(relPath);
      try { safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      const index = parseInt(deleteCommentMatch[2], 10);
      let error: string | null = null;
      const ctx = await updateContext(dir, (context) => {
        if (!context[base]) { error = "Not found"; return; }
        if (index < 0 || index >= context[base].comments.length) { error = "Invalid index"; return; }
        context[base].comments.splice(index, 1);
        if (context[base].comments.length === 0) context[base].status = "pending";
      });
      if (error) return json({ error }, error === "Not found" ? 404 : 400);
      return json(ctx[base]);
    }

    // API: update a comment's region
    const regionMatch = path.match(/^\/api\/files\/(.+)\/comments\/(\d+)\/region$/);
    if (regionMatch && req.method === "PUT") {
      const relPath = decodeURIComponent(regionMatch[1]);
      const { dir, base } = splitRelPath(relPath);
      try { safePath(relPath); } catch { return json({ error: "Invalid path" }, 400); }
      const index = parseInt(regionMatch[2], 10);
      const body = (await req.json()) as { region: Region };
      let error: string | null = null;
      await updateContext(dir, (context) => {
        if (!context[base]) { error = "Not found"; return; }
        if (index < 0 || index >= context[base].comments.length) { error = "Invalid index"; return; }
        context[base].comments[index].region = body.region;
      });
      if (error) return json({ error }, error === "Not found" ? 404 : 400);
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
      let error: string | null = null;
      await updateContext(dir, (context) => {
        if (!context[base]) { error = "Not found"; return; }
        if (index < 0 || index >= context[base].comments.length) { error = "Invalid index"; return; }
        context[base].comments[index].text = body.text;
      });
      if (error) return json({ error }, error === "Not found" ? 404 : 400);
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

    // API: Export annotated regions as cropped images in a zip
    if (path === "/api/export" && req.method === "POST") {
      try {
        const body = await req.json() as any;
        const scope = body.scope; // "file" | "directory" | "root"
        const targetPath = body.path || "";
        const authorFilter = body.authorFilter || "all"; // "all" | "user" | "claude"

        type WorkItem = { relPath: string; comment: any; commentIdx: number };
        const workItems: WorkItem[] = [];

        if (scope === "file") {
          if (!targetPath) return json({ error: "path required for file scope" }, 400);
          const { dir, base } = splitRelPath(targetPath);
          const context = await readContext(dir);
          const fileCtx = context[base];
          if (fileCtx?.comments) {
            fileCtx.comments.forEach((c: any, i: number) => {
              if (c.region) workItems.push({ relPath: targetPath, comment: c, commentIdx: i });
            });
          }
        } else if (scope === "directory") {
          const context = await readContext(targetPath);
          for (const [filename, fileCtx] of Object.entries(context) as any) {
            if (!fileCtx.comments) continue;
            const relPath = targetPath ? `${targetPath}/${filename}` : filename;
            fileCtx.comments.forEach((c: any, i: number) => {
              if (c.region) workItems.push({ relPath, comment: c, commentIdx: i });
            });
          }
        } else if (scope === "root") {
          const allContexts = await collectAllContexts(resolvedFolder, "");
          for (const { dir, filename, fileCtx } of allContexts) {
            const relPath = dir ? `${dir}/${filename}` : filename;
            fileCtx.comments?.forEach((c: any, i: number) => {
              if (c.region) workItems.push({ relPath, comment: c, commentIdx: i });
            });
          }
        } else {
          return json({ error: "Invalid scope. Use 'file', 'directory', or 'root'" }, 400);
        }

        // Apply author filter
        const filtered = authorFilter === "all"
          ? workItems
          : workItems.filter(item => item.comment.author === authorFilter);

        if (filtered.length === 0) {
          return json({ error: "No annotated regions found in the requested scope." }, 400);
        }

        const zip = new JSZip();
        const errors: string[] = [];
        const jsonlLines: string[] = [];
        const addedOriginals = new Set<string>();
        let globalIdx = 0;

        for (const item of filtered) {
          try {
            const filePath = safePath(item.relPath);
            const ext = extname(item.relPath).toLowerCase();
            if (!IMAGE_EXTENSIONS.has(ext)) continue;

            const metadata = await sharp(filePath).metadata();
            const imgW = metadata.width!;
            const imgH = metadata.height!;
            const r = item.comment.region;

            // Deterministic crop filename
            const { dir: relDir, base } = splitRelPath(item.relPath);
            const baseName = base.replace(/\.[^.]+$/, "");
            const cropName = `${baseName}_c${String(globalIdx).padStart(4, "0")}.png`;
            const cropPath = relDir ? `crops/${relDir}/${cropName}` : `crops/${cropName}`;

            const croppedBuffer = await cropRegion(filePath, r);
            zip.file(cropPath, croppedBuffer);

            // Include original image once
            const origPath = relDir ? `originals/${relDir}/${base}` : `originals/${base}`;
            if (!addedOriginals.has(item.relPath)) {
              addedOriginals.add(item.relPath);
              const origBuffer = await Bun.file(filePath).arrayBuffer();
              zip.file(origPath, Buffer.from(origBuffer));
            }

            // Pixel coordinates
            const pxX = Math.round((r.x / 100) * imgW);
            const pxY = Math.round((r.y / 100) * imgH);
            const pxW = Math.min(Math.round((r.w / 100) * imgW), imgW - pxX);
            const pxH = Math.min(Math.round((r.h / 100) * imgH), imgH - pxY);

            jsonlLines.push(JSON.stringify({
              image: cropPath,
              source_image: origPath,
              source_file: item.relPath,
              text: item.comment.text,
              author: item.comment.author,
              region_pct: { x: r.x, y: r.y, w: r.w, h: r.h },
              region_px: { x: pxX, y: pxY, w: pxW, h: pxH, img_w: imgW, img_h: imgH },
            }));

            globalIdx++;
          } catch (e: any) {
            errors.push(`${item.relPath} region #${item.commentIdx + 1}: ${e.message}`);
          }
        }

        zip.file("annotations.jsonl", jsonlLines.join("\n") + "\n");

        // COCO-format JSON for detection tasks
        const cocoImages: any[] = [];
        const cocoAnnotations: any[] = [];
        const imageIdMap = new Map<string, number>();
        let annoId = 1;

        for (const line of jsonlLines) {
          const entry = JSON.parse(line);
          let imageId = imageIdMap.get(entry.source_image);
          if (imageId === undefined) {
            imageId = imageIdMap.size + 1;
            imageIdMap.set(entry.source_image, imageId);
            cocoImages.push({
              id: imageId,
              file_name: entry.source_image,
              width: entry.region_px.img_w,
              height: entry.region_px.img_h,
            });
          }
          cocoAnnotations.push({
            id: annoId++,
            image_id: imageId,
            category_id: 1,
            bbox: [entry.region_px.x, entry.region_px.y, entry.region_px.w, entry.region_px.h],
            area: entry.region_px.w * entry.region_px.h,
            text: entry.text,
            author: entry.author,
            iscrowd: 0,
          });
        }

        zip.file("coco.json", JSON.stringify({
          images: cocoImages,
          annotations: cocoAnnotations,
          categories: [{ id: 1, name: "annotation", supercategory: "none" }],
        }, null, 2));

        if (errors.length > 0) {
          zip.file("_errors.txt", errors.join("\n"));
        }

        const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const filename = `context-export-${scope}-${timestamp}.zip`;

        return new Response(zipBuffer, {
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // API: Download specific files as zip
    if (path === "/api/download-files" && req.method === "POST") {
      try {
        const body = (await req.json()) as any;
        const filePaths: string[] = body.files || [];
        if (filePaths.length === 0) return json({ error: "No files specified" }, 400);

        const zip = new JSZip();
        let added = 0;
        for (const relPath of filePaths) {
          try {
            const absPath = safePath(relPath);
            if (!existsSync(absPath)) continue;
            const data = await readFile(absPath);
            const name = relPath.includes("/") ? relPath : relPath;
            zip.file(name, data);
            added++;
          } catch {}
        }

        if (added === 0) return json({ error: "No valid files found" }, 400);

        const zipBuffer = await zip.generateAsync({ type: "uint8array" });
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const filename = `files-${timestamp}.zip`;

        return new Response(zipBuffer, {
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // API: Chat — conversational Q&A about files and annotations
    if (path === "/api/chat" && req.method === "POST") {
      try {
        const settings = await readSettings();
        if (!settings.apiKey) return json({ error: "No API key configured" }, 400);

        const body = (await req.json()) as any;
        const userMessage = body.message;
        const history = body.history || []; // array of { role, content } from prior turns
        const chatDir = body.dir || "";
        const currentFile = body.currentFile || ""; // relative path of file in detail view, if any

        if (!userMessage) return json({ error: "message required" }, 400);

        // Lightweight file listing — just names and status, no full annotations
        let fileListing = "";
        const { files: allDirFiles, directories: allDirDirs } = await listFiles(chatDir);
        const dirContext = await readContext(chatDir);
        if (allDirDirs?.length) {
          fileListing += "Subdirectories: " + allDirDirs.join(", ") + "\n";
        }
        for (const fn of allDirFiles) {
          const ctx = dirContext[fn] as any;
          const status = ctx?.status || "pending";
          const commentCount = ctx?.comments?.length || 0;
          fileListing += `- ${fn}: ${status} (${commentCount} comments)\n`;
        }

        // If viewing a specific file, include its annotations + content
        let currentFileContext = "";
        if (currentFile) {
          const cfBase = basename(currentFile);
          const cfExt = extname(currentFile).toLowerCase();
          const { dir: cfDir } = splitRelPath(currentFile);
          const cfContext = await readContext(cfDir);
          const cfData = cfContext[cfBase];
          currentFileContext = `\n\n## CURRENTLY VIEWING: ${currentFile}\nThe user is looking at this file in detail view. "This file" means "${cfBase}".\n`;
          if (cfData?.comments?.length) {
            currentFileContext += "\nAnnotations:\n";
            for (let i = 0; i < cfData.comments.length; i++) {
              const c = cfData.comments[i];
              const regionNote = c.region ? ` (region: ${Math.round(c.region.x)}%-${Math.round(c.region.x + c.region.w)}% x)` : "";
              currentFileContext += `- [${c.author.toUpperCase()}, #${i}]${regionNote} ${c.text}\n`;
            }
          }
          if (TEXT_EXTENSIONS.has(cfExt)) {
            try {
              const content = await readFile(safePath(currentFile), "utf-8");
              currentFileContext += `\nFull content:\n${content.slice(0, MAX_DOC_SIZE)}\n`;
            } catch {}
          }
        }

        // Index stats for context
        const idxStats = indexer.getStats();

        // Build system prompt — lightweight, search-first
        const viewContext = currentFile
          ? `The user is currently viewing the file "${basename(currentFile)}" in detail view.`
          : `The user is currently browsing the "${chatDir || "root"}" directory.`;

        const systemTextPrompt = `You are an assistant embedded in Context Annotator, a tool for annotating images and files from design sessions.

Your job is to answer questions about annotated files, help identify patterns, suggest next steps, and provide insights. Be specific and concise.

${viewContext}

## Project info
The project has ${idxStats.totalFiles} indexed files, ${idxStats.totalAnnotations} annotations, across multiple directories. The current directory contains:
${fileListing}
${currentFileContext}

## HOW TO ANSWER QUESTIONS

You have a **search_index** tool that searches a full-text index across ALL ${idxStats.totalFiles} files in the entire project. USE IT LIBERALLY:
- For ANY question about topics, people, meetings, decisions, or content — search first
- If the user asks about something not obviously in the file listing above — search
- If the user mentions a specific meeting, person, or subject — search
- For cross-cutting questions ("What did we decide about X?") — search
- You can search multiple times with different queries to find comprehensive answers

NEVER say "I don't see that" or "I can't find that" without searching first. Always search before giving up.

Only skip searching when the user is clearly asking about a specific file they're viewing and you already have its full content above.

## Reference syntax
- Reference files: [[file:FILENAME]] — e.g. [[file:IMG_5210.jpeg]] or [[file:Notes/meeting.txt]]
- Reference comments: [[comment:FILENAME#INDEX]] — e.g. [[comment:IMG_5210.jpeg#3]]
Use exact filenames from search results or the listing above.`;

        // Build messages array with history
        const messages: any[] = [];
        const recentHistory = history.slice(-20);

        for (const turn of recentHistory) {
          messages.push({ role: turn.role, content: turn.content });
        }
        // Build user message content — text + optional image attachments
        const attachments = body.attachments || []; // [{type:"project",path:"..."} or {type:"upload",data:"base64...",mediaType:"image/png",name:"..."}]
        const userContent: any[] = [];

        for (const att of attachments) {
          try {
            let imageBuffer: Buffer;
            let mediaType: string;
            let label: string;

            if (att.type === "project") {
              // Load from project directory, optionally cropping a region
              const filePath = safePath(att.path);
              const ext = extname(att.path).toLowerCase();
              mediaType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
              let rawBuffer: Buffer;
              if (att.region && typeof att.region.x === "number") {
                // Crop to the specified region first
                rawBuffer = await cropRegion(filePath, att.region);
                mediaType = "image/png"; // cropRegion outputs PNG
              } else {
                rawBuffer = Buffer.from(await readFile(filePath));
              }
              imageBuffer = await resizeForApi(rawBuffer, mediaType);
              label = att.region ? `${att.path} (crop)` : att.path;
            } else if (att.type === "upload") {
              mediaType = att.mediaType || "image/png";
              imageBuffer = await resizeForApi(Buffer.from(att.data, "base64"), mediaType);
              label = att.name || "uploaded image";
            } else continue;

            userContent.push({
              type: "image",
              source: { type: "base64", media_type: mediaType, data: imageBuffer.toString("base64") },
            });
            userContent.push({ type: "text", text: `[Attached: ${label}]` });
          } catch (e: any) {
            userContent.push({ type: "text", text: `[Failed to load attachment: ${e.message}]` });
          }
        }

        userContent.push({ type: "text", text: userMessage });
        messages.push({ role: "user", content: userContent.length === 1 ? userMessage : userContent });

        // Tool definitions
        const tools = [
          {
            name: "show_files",
            description: "Present a collection of files to the user as a visual smart card with thumbnails and a download option. Use this when the user asks to see, find, or collect files matching certain criteria (e.g. 'show me files about nutrition', 'which files relate to the dashboard'). Only include files that actually exist in the data provided to you.",
            input_schema: {
              type: "object",
              properties: {
                files: {
                  type: "array",
                  items: { type: "string" },
                  description: "Array of filenames exactly as they appear in the annotation data (e.g. 'IMG_5210.jpeg' or 'subdir/photo.jpg')"
                },
                description: {
                  type: "string",
                  description: "A short, natural description of what these files have in common (e.g. 'nutrition tracking screens', 'onboarding flow wireframes')"
                }
              },
              required: ["files", "description"]
            }
          },
          {
            name: "search_index",
            description: "Search the project index for files and information matching a query. Use this when the user asks about topics, people, decisions, or commitments that may span many files beyond the current directory. Returns relevant excerpts with file references. Especially useful for large projects with many files.",
            input_schema: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "Natural language search query — keywords or phrases to find"
                },
                filters: {
                  type: "object",
                  properties: {
                    people: { type: "array", items: { type: "string" }, description: "Filter by people mentioned" },
                    chunk_type: { type: "array", items: { type: "string" }, description: "Filter by type: summary, decision, action_item, commitment, topics, full_text, annotation" },
                    date_from: { type: "string", description: "ISO date, earliest" },
                    date_to: { type: "string", description: "ISO date, latest" },
                    directory: { type: "string", description: "Limit to specific subdirectory" },
                    file_type: { type: "string", description: "Filter by file type: text, image, pdf" }
                  }
                },
                limit: { type: "number", description: "Max results to return (default 10, max 25)" }
              },
              required: ["query"]
            }
          }
        ];

        // Multi-turn tool-use loop — Claude calls tools, we execute and continue
        // 6 rounds allows: search → search → answer, with room for show_files too
        const MAX_TOOL_ROUNDS = 6;
        let reply = "";
        let fileset: { files: string[]; description: string } | null = null;
        const MAX_SEARCH_RESULT_CHARS = 8000; // Cap search results to avoid blowing up context

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": settings.apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 2048,
              system: systemTextPrompt,
              messages,
              tools,
            }),
          });

          if (!apiRes.ok) {
            // Retry once on rate limit after waiting
            if (apiRes.status === 429) {
              const wait = Math.min(parseInt(apiRes.headers.get("retry-after") || "10"), 30);
              await new Promise(r => setTimeout(r, wait * 1000));
              continue; // retry the same round
            }
            const err = await apiRes.text();
            return json({ error: `Claude API error: ${apiRes.status} ${err}` }, 500);
          }

          const data = (await apiRes.json()) as any;

          // Extract text and tool calls from this round
          let roundText = "";
          const toolUses: any[] = [];
          for (const block of data.content) {
            if (block.type === "text") {
              roundText += block.text;
            } else if (block.type === "tool_use") {
              toolUses.push(block);
              if (block.name === "show_files") {
                fileset = block.input as { files: string[]; description: string };
              }
            }
          }

          // If this is the final response (no more tool calls), use this text as the reply
          if (data.stop_reason !== "tool_use" || toolUses.length === 0) {
            if (roundText.trim()) reply = roundText;
            break;
          }
          // Otherwise this is intermediate "thinking" text — discard it

          // Execute tool calls
          messages.push({ role: "assistant", content: data.content });
          const toolResults: any[] = [];

          for (const tool of toolUses) {
            if (tool.name === "search_index") {
              const input = tool.input as { query: string; filters?: any; limit?: number };
              const searchResults = indexer.search(
                input.query,
                input.filters,
                Math.min(input.limit || 10, 25)
              );
              let formatted = searchResults.map(r => {
                // Truncate individual results to keep total size manageable
                const content = r.content.length > 2000 ? r.content.slice(0, 2000) + "..." : r.content;
                return `[${r.chunkType}] ${r.filePath}: ${content}${r.people ? ` (people: ${r.people})` : ""}`;
              }).join("\n\n");
              if (formatted.length > MAX_SEARCH_RESULT_CHARS) {
                formatted = formatted.slice(0, MAX_SEARCH_RESULT_CHARS) + "\n\n[Results truncated]";
              }
              toolResults.push({
                type: "tool_result",
                tool_use_id: tool.id,
                content: searchResults.length > 0
                  ? `Found ${searchResults.length} results:\n\n${formatted}`
                  : "No results found. Try different keywords.",
              });
            } else if (tool.name === "show_files") {
              toolResults.push({
                type: "tool_result",
                tool_use_id: tool.id,
                content: `File card will be shown with ${(tool.input as any).files.length} files.`,
              });
            }
          }

          messages.push({ role: "user", content: toolResults });
        }

        // If we exhausted all rounds without a final text response, do one last call without tools
        if (!reply && !fileset) {
          try {
            const finalRes = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": settings.apiKey,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: "claude-sonnet-4-20250514",
                max_tokens: 2048,
                system: systemTextPrompt,
                messages,
                // No tools — force a text response
              }),
            });
            if (finalRes.ok) {
              const finalData = (await finalRes.json()) as any;
              for (const block of finalData.content) {
                if (block.type === "text") reply += block.text;
              }
            } else {
              const errBody = await finalRes.text();
              console.error("Final toolless call failed:", finalRes.status, errBody.slice(0, 300));
            }
          } catch (finalErr: any) {
            console.error("Final toolless call error:", finalErr.message);
          }
        }

        if (!reply && !fileset) reply = "Sorry, I wasn't able to generate a response. Try rephrasing your question.";

        const result: any = { reply };
        if (fileset) result.fileset = fileset;
        return json(result);
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    return new Response("Not Found", { status: 404 });
}

console.log(`Context Annotator running at http://localhost:${PORT}`);
console.log(`Watching folder: ${resolvedFolder}`);
