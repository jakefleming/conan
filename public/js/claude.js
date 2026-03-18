// ── Claude Analysis & Index Management ──

async function checkApiKey() {
  const config = await api('/api/config');
  hasApiKey = config.hasApiKey;
  updateAskClaudeButton();
}

function updateAskClaudeButton() {
  // No-op — Ask Claude is now triggered via Cmd+Enter
}

async function updateIndexStatus() {
  try {
    const stats = await api('/api/index/stats');
    const dot = document.getElementById('index-dot');
    if (stats.indexing) {
      dot.className = 'index-dot yellow';
      dot.title = 'Indexing in progress...';
    } else if (stats.totalFiles > 0) {
      dot.className = 'index-dot green';
      dot.title = `${stats.totalFiles} files indexed`;
    } else {
      dot.className = 'index-dot gray';
      dot.title = 'Index empty';
    }
    return stats;
  } catch { return null; }
}

async function showIndexPanel() {
  const modal = document.getElementById('index-modal');
  modal.classList.add('active');
  const statsEl = document.getElementById('index-stats');
  statsEl.textContent = 'Loading...';
  const stats = await updateIndexStatus();
  if (!stats) {
    statsEl.textContent = 'Failed to load index stats.';
    return;
  }
  statsEl.innerHTML = `
    <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;align-items:center">
      <span style="color:var(--text-tertiary)">Files indexed</span><strong>${stats.totalFiles}</strong>
      <span style="color:var(--text-tertiary)">Extracted chunks</span><strong>${stats.totalChunks}</strong>
      <span style="color:var(--text-tertiary)">Annotations synced</span><strong>${stats.totalAnnotations}</strong>
      <span style="color:var(--text-tertiary)">Pending extraction</span><strong>${stats.pendingExtraction}</strong>
      <span style="color:var(--text-tertiary)">Status</span><strong>${stats.indexing ? '⏳ Indexing...' : '✓ Up to date'}</strong>
      ${stats.lastIndexed ? `<span style="color:var(--text-tertiary)">Last indexed</span><strong>${new Date(stats.lastIndexed).toLocaleString()}</strong>` : ''}
    </div>
    <p style="margin-top:12px;font-size:12px;color:var(--text-tertiary)">The search index enables Claude to find information across all your files. It rebuilds automatically when files change.</p>
  `;
}

async function reindexProject() {
  const btn = document.getElementById('btn-reindex');
  btn.disabled = true;
  btn.textContent = 'Rebuilding...';
  document.getElementById('index-dot').className = 'index-dot yellow';
  try {
    const result = await api('/api/index/reindex', { method: 'POST' });
    await showIndexPanel(); // refresh stats
    btn.textContent = 'Rebuild Index';
    btn.disabled = false;
  } catch (e) {
    btn.textContent = 'Rebuild Index';
    btn.disabled = false;
  }
}

async function askClaudeForFile() {
  if (!hasApiKey) {
    document.getElementById('btn-settings').click();
    return;
  }
  const file = onlyFiles()[currentIndex];
  if (!file) return;

  const input = document.getElementById('comment-input');
  const prompt = input.value.trim();

  // Show loading state on send button
  const sendBtn = document.getElementById('btn-add-comment');
  const originalHtml = sendBtn.innerHTML;
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<i class="ph ph-spinner" style="font-size:18px;animation:spin 1s linear infinite"></i>';

  // Clear input
  if (prompt) {
    input.value = '';
    input.style.height = 'auto';
  }

  try {
    const body = {};
    if (prompt) body.prompt = prompt;
    if (sidebarAttachments.length > 0) {
      body.attachments = sidebarAttachments.map(att => {
        if (att.type === 'project') return { type: 'project', path: att.path, region: att.region };
        return { type: 'upload', data: att.data, mediaType: att.mediaType, name: att.name };
      });
    }
    const res = await api(`/api/files/${encodeURIComponent(file.path)}/ask-claude`, { method: 'POST', body: Object.keys(body).length > 0 ? body : undefined });
    if (res.error) {
      alert('Error: ' + res.error);
    }
  } catch (e) {
    alert('Failed to reach Claude: ' + e.message);
  } finally {
    sendBtn.disabled = false;
    sendBtn.innerHTML = originalHtml;
    sidebarAttachments = [];
    renderSidebarAttachments();
    await reloadCurrentDir();
    refreshSidebar();
  }
}
