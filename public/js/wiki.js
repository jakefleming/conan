// ── Wiki manual ingest button ──
// Topbar button to trigger an immediate wiki ingest of the current file,
// bypassing the 3-minute auto-ingest debounce. Useful when you want the
// wiki to update *now* instead of waiting for the timer.

(function () {
  const btn = document.getElementById('btn-wiki-ingest');
  if (!btn) return;

  let inFlight = false;

  function currentFilePath() {
    // In gallery mode, the focused file is the right target.
    if (typeof galleryMode !== 'undefined' && galleryMode) {
      const items = (typeof onlyFiles === 'function') ? onlyFiles() : [];
      const f = items[currentIndex];
      return f?.path || null;
    }
    return null;
  }

  function setBusy(busy) {
    inFlight = busy;
    btn.disabled = busy;
    btn.style.opacity = busy ? '0.5' : '';
    btn.style.cursor = busy ? 'wait' : '';
  }

  btn.addEventListener('click', async () => {
    if (inFlight) return;

    const path = currentFilePath();
    if (!path) {
      showToast('Open a file first to ingest it', 'info');
      return;
    }

    setBusy(true);
    showToast(`Ingesting ${path.split('/').pop()}...`, 'info', 2000);
    try {
      const res = await api('/api/wiki/ingest', {
        method: 'POST',
        body: { sourcePath: path },
      });
      if (res?.error) {
        showToast(`Wiki ingest failed: ${res.error}`, 'info', 6000);
      } else {
        const n = Array.isArray(res?.pages) ? res.pages.length : 0;
        showToast(`Wiki updated: ${n} page${n === 1 ? '' : 's'}`, 'success');
      }
    } catch (e) {
      showToast(`Wiki ingest failed: ${e.message || e}`, 'info', 6000);
    } finally {
      setBusy(false);
    }
  });
})();
