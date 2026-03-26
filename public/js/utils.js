// utils.js — extracted from index.html

// Forward declaration stubs for functions defined in later-loading modules
// These get overwritten when the real module loads
function updateChatFabVisibility() {} // defined in chat.js

// Helper to read CSS custom properties (for theme-aware JS colors)
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.svg'];
const TEXT_EXTS = ['.txt', '.md', '.json', '.log', '.yml', '.yaml', '.toml', '.xml', '.html', '.css', '.js', '.ts', '.py', '.sh', '.bash', '.zsh', '.env', '.ini', '.cfg', '.conf'];
const SPREADSHEET_EXTS = ['.xlsx', '.xls', '.csv', '.tsv', '.ods', '.numbers'];
const DOCUMENT_EXTS = ['.docx', '.doc'];
const FILE_ICONS = {
  '.pdf': '📄', '.txt': '📝', '.md': '📝',
  '.doc': '📃', '.docx': '📃',
  '.xlsx': '📊', '.xls': '📊', '.ods': '📊', '.numbers': '📊',
  '.csv': '📊', '.tsv': '📊',
};

// ── API helpers ──
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

// ── Toast notifications ──
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icon = type === 'success' ? '✓' : 'ℹ';
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toast-out 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showRefError(message) {
  const tooltip = document.createElement('div');
  tooltip.className = 'ref-error-tooltip';
  tooltip.textContent = message;
  tooltip.style.top = '50%';
  tooltip.style.left = '50%';
  tooltip.style.transform = 'translate(-50%, -50%)';
  document.body.appendChild(tooltip);
  setTimeout(() => tooltip.remove(), 2000);
}

// ── Punctuation Heuristics ──
function punctuate(raw) {
  if (!raw) return raw;
  let text = raw.trim();
  if (!text) return text;

  // Capitalize first letter
  text = text.charAt(0).toUpperCase() + text.slice(1);

  // Common spoken sentence-enders: add period before conjunctions that start new thoughts
  // "and then" / "so then" / "but then" in the middle often indicate new sentences
  const sentenceBreakers = /\b(so basically|and so|but anyway|okay so|and then I|but I think|so I think|also I|and I think)\b/gi;
  text = text.replace(sentenceBreakers, (match) => {
    return '. ' + match.charAt(0).toUpperCase() + match.slice(1);
  });

  // Capitalize after existing periods, question marks, exclamation marks
  text = text.replace(/([.!?])\s+([a-z])/g, (_, p, c) => p + ' ' + c.toUpperCase());

  // If text doesn't end with punctuation, add a period
  if (!/[.!?]$/.test(text)) {
    text += '.';
  }

  // Capitalize "I" standing alone
  text = text.replace(/\bi\b/g, 'I');

  // Capitalize common proper nouns that speech recognition lowercases
  const properNouns = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  for (const noun of properNouns) {
    const regex = new RegExp('\\b' + noun + '\\b', 'gi');
    text = text.replace(regex, noun.charAt(0).toUpperCase() + noun.slice(1));
  }

  // Clean up double spaces and double periods
  text = text.replace(/\s{2,}/g, ' ');
  text = text.replace(/\.{2,}/g, '.');
  text = text.replace(/\.\s*\./g, '.');

  return text;
}

// ── Marked.js custom renderer for summary references ──
function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
