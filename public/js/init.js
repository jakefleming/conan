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

// ── History-based routing ──
let _navFromPopstate = false;

function buildHash(dir, filePath) {
  if (filePath) return '#' + encodeURIComponent(filePath);
  if (dir) return '#' + encodeURIComponent(dir);
  return '#';
}

function navPushState(dir, filePath, scrollTop) {
  const state = { dir: dir || '', file: filePath || null, scrollTop: scrollTop || 0 };
  const hash = buildHash(dir, filePath);
  history.pushState(state, '', hash);
}

function navReplaceState(dir, filePath, scrollTop) {
  const state = { dir: dir || '', file: filePath || null, scrollTop: scrollTop || 0 };
  const hash = buildHash(dir, filePath);
  history.replaceState(state, '', hash);
}

function getScrollTop() {
  const mp = document.querySelector('.markdown-preview');
  if (mp) return mp.scrollTop;
  const overview = document.getElementById('overview-container');
  if (overview) return overview.scrollTop;
  return 0;
}

function restoreScrollPosition(scrollTop) {
  // Content may load async (e.g. markdown fetch), so poll briefly
  let attempts = 0;
  const tryRestore = () => {
    const mp = document.querySelector('.markdown-preview');
    const tp = document.querySelector('.text-preview');
    const target = mp || tp;
    if (target && target.scrollHeight > target.clientHeight) {
      target.scrollTop = scrollTop;
      return;
    }
    if (++attempts < 20) setTimeout(tryRestore, 100);
  };
  tryRestore();
}

function initFromHash() {
  const hash = location.hash.slice(1);
  if (hash) {
    const decoded = decodeURIComponent(hash);
    // Check if it's a file path (has an extension) or a directory
    if (/\.\w+$/.test(decoded)) {
      // It's a file — extract directory
      currentDir = decoded.includes('/') ? decoded.substring(0, decoded.lastIndexOf('/')) : '';
      // We'll open the file after loadFiles completes
      window._pendingFileOpen = decoded;
    } else {
      currentDir = decoded;
    }
  }
  // Set initial state
  navReplaceState(currentDir, window._pendingFileOpen || null, 0);
}

window.addEventListener('popstate', async (e) => {
  const state = e.state;
  if (!state) return;
  _navFromPopstate = true;
  try {
    // Navigate to directory if different
    if (state.dir !== currentDir) {
      currentDir = state.dir || '';
      await loadFiles();
    }
    if (state.file) {
      // Open the file
      const idx = onlyFiles().findIndex(f => f.path === state.file);
      if (idx !== -1) {
        currentIndex = idx;
        enterGallery(() => {
          // Restore scroll position after content loads
          if (state.scrollTop) {
            restoreScrollPosition(state.scrollTop);
          }
        });
      }
    } else {
      // Directory view
      if (galleryMode) exitGallery(true);
      // Restore scroll position
      if (state.scrollTop) {
        const overview = document.getElementById('overview-container');
        if (overview) overview.scrollTop = state.scrollTop;
      }
    }
  } finally {
    _navFromPopstate = false;
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
loadFiles().then(() => {
  if (window._pendingFileOpen) {
    const filePath = window._pendingFileOpen;
    delete window._pendingFileOpen;
    const idx = onlyFiles().findIndex(f => f.path === filePath);
    if (idx !== -1) {
      currentIndex = idx;
      enterGallery();
    }
  }
});
checkApiKey();
updateIndexStatus();
// Check for auto-reconcile notifications after a short delay (server startup may still be running)
setTimeout(checkReconcileNotifications, 3000);
