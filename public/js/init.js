// init.js — extracted from index.html
// Event listeners, keyboard shortcuts, and startup initialization

// ── Gallery button event listeners ──
document.getElementById('btn-back').addEventListener('click', exitGallery);
document.getElementById('btn-reveal-finder').addEventListener('click', () => {
  const fileItems = onlyFiles();
  if (!fileItems[currentIndex]) return;
  fetch(`/api/files/${encodeURIComponent(fileItems[currentIndex].path)}/reveal`, { method: 'POST' });
});
document.getElementById('btn-add-comment').addEventListener('click', (e) => {
  if (e.altKey) {
    askClaudeForFile();
  } else {
    addComment();
  }
});
document.getElementById('nav-prev').addEventListener('click', goPrev);
document.getElementById('nav-next').addEventListener('click', goNext);
document.getElementById('btn-rotate-ccw').addEventListener('click', () => rotateCanvas(-90));
document.getElementById('btn-rotate-cw').addEventListener('click', () => rotateCanvas(90));
document.getElementById('btn-toggle-annotations').addEventListener('click', () => {
  showAnnotations = !showAnnotations;
  document.getElementById('btn-toggle-annotations').classList.toggle('off', !showAnnotations);
  renderRegionOverlay();
});

// Comment input: Enter to submit (Shift+Enter for newline); empty input + staged region → Ask Claude
document.getElementById('comment-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.altKey) {
    e.preventDefault();
    askClaudeForFile();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const hasText = document.getElementById('comment-input').value.trim();
    if (hasText) {
      addComment();
    } else if (stagedRegion) {
      describeRegionWithClaude();
    }
  }
});

// Alt key: swap send button icon to sparkle while held
const sendBtnIcon = '<i class="ph ph-paper-plane-tilt" style="font-size:18px"></i>';
const claudeIcon = '<i class="ph ph-sparkle" style="font-size:18px"></i>';
document.addEventListener('keydown', (e) => {
  if (e.key === 'Alt') {
    const btn = document.getElementById('btn-add-comment');
    if (btn && !btn.disabled) btn.innerHTML = claudeIcon;
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'Alt') {
    const btn = document.getElementById('btn-add-comment');
    if (btn && !btn.disabled) btn.innerHTML = sendBtnIcon;
  }
});

document.getElementById('search-input').addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  renderGrid();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Don't intercept when typing in input or using modifier keys (Cmd+R, Ctrl+R, etc.)
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey) {
    return;
  }

  if (!galleryMode) {
    if (e.key === 'Enter') { startAddContext(); e.preventDefault(); }
    if (e.key === 'm' || e.key === 'M') { toggleSummary(); e.preventDefault(); }
    return;
  }

  switch (e.key) {
    case 'ArrowLeft': goPrev(); e.preventDefault(); break;
    case 'ArrowRight': goNext(); e.preventDefault(); break;
    case '/': document.getElementById('comment-input').focus(); e.preventDefault(); break;
    case 'r': case 'R': toggleRecording(); e.preventDefault(); break;
    case 'Delete':
    case 'Backspace':
      if (selectedRegionIndex !== null) {
        const file = onlyFiles()[currentIndex];
        if (file) {
          const idx = selectedRegionIndex;
          selectedRegionIndex = null;
          deleteComment(file.path, idx);
        }
        e.preventDefault();
      }
      break;
    case 'Escape':
      if (selectedRegionIndex !== null) {
        selectedRegionIndex = null;
        renderRegionOverlay();
      } else if (editingRegionIndex !== null) {
        editingRegionIndex = null;
        renderRegionOverlay();
      } else {
        exitGallery();
      }
      e.preventDefault();
      break;
    case '[': rotateCanvas(-90); e.preventDefault(); break;
    case ']': rotateCanvas(90); e.preventDefault(); break;
  }
});

// ── Voice initialization ──
document.getElementById('btn-mic').addEventListener('click', toggleRecording);
initVoice();

// ── Hash-based directory routing ──
function initFromHash() {
  const hash = location.hash.slice(1);
  if (hash) {
    currentDir = decodeURIComponent(hash);
  }
}

window.addEventListener('hashchange', () => {
  const hash = location.hash.slice(1);
  const dir = hash ? decodeURIComponent(hash) : '';
  if (dir !== currentDir) {
    currentDir = dir;
    loadFiles();
  }
});

// Keyboard: Backspace to go up a directory (when not in gallery or input)
document.addEventListener('keydown', (e) => {
  if (galleryMode) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Backspace' && currentDir) {
    e.preventDefault();
    const parts = currentDir.split('/');
    parts.pop();
    navigateToDir(parts.join('/'));
  }
});

// ── Startup ──
initFromHash();
loadConfig();
loadFiles();
checkApiKey();
updateIndexStatus();
// Check for auto-reconcile notifications after a short delay (server startup may still be running)
setTimeout(checkReconcileNotifications, 3000);
