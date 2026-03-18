// ── Summary Siderail ──
// Extracted from index.html: summary loading, rendering, editing, versioning, generation

// ── Marked.js custom renderer for summary references ──

if (typeof marked !== 'undefined') {
  marked.use({
    renderer: {
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);

        // Handle comment:FILENAME:INDEX links
        const commentMatch = href && href.match(/^comment:(.+):(\d+)$/);
        if (commentMatch) {
          const filename = decodeURIComponent(commentMatch[1]);
          const commentIndex = commentMatch[2];
          return `<a class="ref-comment" data-ref-type="comment" data-file="${escapeAttr(filename)}" data-comment-index="${commentIndex}" title="Go to comment #${commentIndex} on ${escapeAttr(filename)}">${text}</a>`;
        }

        // Handle image:FILENAME links
        const imageMatch = href && href.match(/^image:(.+)$/);
        if (imageMatch) {
          const filename = decodeURIComponent(imageMatch[1]);
          return `<a class="ref-image" data-ref-type="image" data-file="${escapeAttr(filename)}" title="View ${escapeAttr(filename)}">${text}</a>`;
        }

        // Default link rendering
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
        return `<a href="${href}"${titleAttr} target="_blank" rel="noopener">${text}</a>`;
      }
    }
  });
}

async function loadSummary() {
  const dirParam = currentDir ? `?dir=${encodeURIComponent(currentDir)}` : '';
  const data = await api(`/api/summary${dirParam}`);
  if (data.content !== null && data.lastModified !== summaryLastModified) {
    summaryRawContent = data.content;
    summaryLastModified = data.lastModified;
    if (!summaryEditMode) renderSummary();
  } else if (data.content === null) {
    summaryRawContent = '';
    summaryLastModified = null;
    if (!summaryEditMode) renderSummary();
  }
}

function fixCitationLinks(md) {
  // Encode spaces inside (comment:...) and (image:...) links so marked can parse them
  return md.replace(/\]\((comment|image):([^)]+)\)/g, (match, type, path) => {
    const encoded = path.replace(/ /g, '%20');
    return `](${type}:${encoded})`;
  });
}

function renderSummary() {
  const el = document.getElementById('summary-content');
  const hasContent = !!summaryRawContent;

  // Show/hide header buttons that require content
  document.querySelectorAll('.summary-has-content').forEach(btn => {
    btn.style.display = hasContent ? '' : 'none';
  });

  if (!hasContent) {
    const hasDirs = onlyDirs().length > 0;
    const dirName = currentDir ? currentDir.split('/').pop() : 'root';
    el.innerHTML = `<div class="summary-empty">
      <div class="summary-empty-icon"><i class="ph ph-file-text" style="font-size:40px"></i></div>
      <div class="summary-empty-title">No summary yet</div>
      <div class="summary-empty-desc">Summarize all annotations${hasDirs ? ' in this directory' : ''} using Claude.</div>
      <div class="summary-empty-buttons">
        <button class="btn btn-primary" id="btn-generate-empty">
          <i class="ph ph-sparkle" style="font-size:14px"></i>
          Summarize ${escapeHtml(dirName)} directory
        </button>
      </div>
      ${hasDirs ? `<div class="summary-empty-buttons">
        <button class="btn btn-ghost" id="btn-generate-all-empty">
          <i class="ph ph-folders" style="font-size:14px"></i>
          Summarize all subdirectories
        </button>
      </div>` : ''}
    </div>`;
    document.getElementById('btn-generate-empty')?.addEventListener('click', () => generateSummaryAction(false));
    document.getElementById('btn-generate-all-empty')?.addEventListener('click', () => generateSummaryAction(true));
    return;
  }
  if (summaryEditMode) {
    el.innerHTML = `<textarea class="summary-editor" id="summary-editor">${escapeHtml(summaryRawContent)}</textarea>`;
  } else {
    const fixed = fixCitationLinks(summaryRawContent);
    const html = (typeof marked !== 'undefined') ? marked.parse(fixed) : `<pre>${escapeHtml(summaryRawContent)}</pre>`;
    el.innerHTML = `<div class="summary-rendered">${html}</div>`;
  }
}

function closeSummaryInstant() {
  summaryVisible = false;
  const rail = document.getElementById('summary-siderail');
  rail.classList.remove('active');
  document.body.classList.remove('summary-open');
  document.getElementById('btn-toggle-summary').style.display = '';
}

function toggleSummary() {
  summaryVisible = !summaryVisible;
  const rail = document.getElementById('summary-siderail');
  const btn = document.getElementById('btn-toggle-summary');
  if (summaryVisible) {
    // Instant swap if chat is open
    if (chatOpen) {
      const chatPanel = document.getElementById('chat-panel');
      rail.style.transition = 'none';
      chatPanel.style.transition = 'none';
      closeChatInstant();
      rail.classList.add('active');
      document.body.classList.add('summary-open');
      btn.style.display = 'none';
      // Re-enable transitions next frame
      requestAnimationFrame(() => {
        rail.style.transition = '';
        chatPanel.style.transition = '';
      });
    } else {
      rail.classList.add('active');
      document.body.classList.add('summary-open');
      btn.style.display = 'none';
    }
    loadSummary();
    loadVersionList();
  } else {
    rail.classList.remove('active');
    document.body.classList.remove('summary-open');
    btn.style.display = '';
  }
}

function toggleSummaryEdit() {
  const editBtn = document.getElementById('btn-summary-edit');
  if (summaryEditMode) {
    const editor = document.getElementById('summary-editor');
    if (editor) {
      summaryRawContent = editor.value;
      const dirParam = currentDir ? `?dir=${encodeURIComponent(currentDir)}` : '';
      api(`/api/summary${dirParam}`, { method: 'POST', body: { content: summaryRawContent } });
    }
    summaryEditMode = false;
    editBtn.innerHTML = '<i class="ph ph-pencil-simple" style="font-size:16px"></i>';
    editBtn.title = 'Edit';
    renderSummary();
  } else {
    summaryEditMode = true;
    editBtn.innerHTML = '<i class="ph ph-check" style="font-size:16px"></i>';
    editBtn.title = 'Done editing';
    renderSummary();
    const editor = document.getElementById('summary-editor');
    if (editor) editor.focus();
  }
}

function copySummary() {
  if (!summaryRawContent) return;
  navigator.clipboard.writeText(summaryRawContent).then(() => {
    const btn = document.getElementById('btn-summary-copy');
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<i class="ph ph-check" style="font-size:16px"></i>';
    setTimeout(() => { btn.innerHTML = originalHtml; }, 1500);
  });
}

async function generateSummaryAction(aggregate = false) {
  if (!hasApiKey) {
    document.getElementById('btn-settings').click();
    return;
  }

  // Close regen dropdown if open
  const regenDd = document.getElementById('summary-regen-dropdown');
  if (regenDd) regenDd.classList.remove('open');

  // Show loading state in summary content area
  const el = document.getElementById('summary-content');
  const dirName = currentDir ? currentDir.split('/').pop() : 'root';
  const scope = aggregate ? 'all subdirectories' : `${dirName} directory`;
  const steps = [
    'Reading annotations...',
    'Scanning text documents...',
    'Analyzing with Claude...',
    'Structuring summary...',
  ];
  let stepIdx = 0;
  el.innerHTML = `
    <div class="summary-loading">
      <div class="summary-loading-spinner"></div>
      <div class="summary-loading-text">
        Summarizing <strong>${escapeHtml(scope)}</strong>
        <div class="summary-loading-step" id="loading-step">${steps[0]}</div>
      </div>
      <div class="summary-loading-shimmer">
        <div class="shimmer-line"></div>
        <div class="shimmer-line"></div>
        <div class="shimmer-line"></div>
        <div class="shimmer-line"></div>
      </div>
    </div>`;

  const stepInterval = setInterval(() => {
    stepIdx = Math.min(stepIdx + 1, steps.length - 1);
    const stepEl = document.getElementById('loading-step');
    if (stepEl) stepEl.textContent = steps[stepIdx];
  }, 3000);

  try {
    let url = '/api/summary/generate';
    const params = [];
    if (currentDir) params.push(`dir=${encodeURIComponent(currentDir)}`);
    if (aggregate) params.push('aggregate=true');
    if (params.length) url += '?' + params.join('&');
    const res = await api(url, { method: 'POST', body: {} });
    if (res.error) {
      alert('Error: ' + res.error);
      renderSummary(); // restore previous state
    } else if (res.content) {
      summaryRawContent = res.content;
      summaryCurrentVersion = res.version;
      summaryTotalVersions = res.totalVersions;
      summaryLastModified = new Date().toISOString();
      renderSummary();
      updateVersionNav();
    }
  } catch (e) {
    alert('Failed to summarize: ' + e.message);
    renderSummary();
  } finally {
    clearInterval(stepInterval);
  }
}

function updateVersionNav() {
  // Populate version dropdown list
  const list = document.getElementById('summary-version-list');
  if (!list) return;
  if (summaryTotalVersions <= 0) {
    list.innerHTML = '<div style="padding:8px 10px;color:var(--text-muted);font-size:12px">No versions yet</div>';
    return;
  }
  let html = '';
  for (let v = summaryTotalVersions; v >= 1; v--) {
    const isActive = v === summaryCurrentVersion;
    html += `<button class="summary-version-item${isActive ? ' active' : ''}" data-version="${v}">Version ${v}${v === summaryTotalVersions ? ' (latest)' : ''}</button>`;
  }
  list.innerHTML = html;
}

async function loadVersion(version) {
  try {
    const dirParam = currentDir ? `?dir=${encodeURIComponent(currentDir)}` : '';
    const res = await api(`/api/summary/versions/${version}${dirParam}`);
    if (res.error) return;
    summaryRawContent = res.content;
    summaryCurrentVersion = res.version;
    summaryTotalVersions = res.totalVersions;
    renderSummary();
    updateVersionNav();
  } catch (e) { /* ignore */ }
}

async function loadVersionList() {
  try {
    const dirParam = currentDir ? `?dir=${encodeURIComponent(currentDir)}` : '';
    const res = await api(`/api/summary/versions${dirParam}`);
    summaryTotalVersions = res.total;
    if (res.total > 0) {
      summaryCurrentVersion = res.versions[res.versions.length - 1];
      updateVersionNav();
    }
  } catch (e) { /* ignore */ }
}

document.getElementById('btn-toggle-summary').addEventListener('click', toggleSummary);
document.getElementById('btn-summary-close').addEventListener('click', toggleSummary);
document.getElementById('btn-summary-edit').addEventListener('click', toggleSummaryEdit);
document.getElementById('btn-summary-copy').addEventListener('click', copySummary);

// Version dropdown
document.getElementById('btn-version-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('summary-regen-dropdown').classList.remove('open');
  document.getElementById('summary-version-dropdown').classList.toggle('open');
});
document.getElementById('summary-version-list').addEventListener('click', (e) => {
  const item = e.target.closest('[data-version]');
  if (!item) return;
  const v = parseInt(item.dataset.version);
  loadVersion(v);
  document.getElementById('summary-version-dropdown').classList.remove('open');
});

// Regenerate dropdown
document.getElementById('btn-regenerate-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('summary-version-dropdown').classList.remove('open');
  document.getElementById('summary-regen-dropdown').classList.toggle('open');
});
document.getElementById('btn-regen-dir').addEventListener('click', () => generateSummaryAction(false));
document.getElementById('btn-regen-all').addEventListener('click', () => generateSummaryAction(true));

// Close dropdowns on outside click
document.addEventListener('click', (e) => {
  const vd = document.getElementById('summary-version-dropdown');
  const rd = document.getElementById('summary-regen-dropdown');
  if (vd && !vd.contains(e.target)) vd.classList.remove('open');
  if (rd && !rd.contains(e.target)) rd.classList.remove('open');
});

// Summary reference click delegation
document.getElementById('summary-content').addEventListener('click', (e) => {
  const refEl = e.target.closest('[data-ref-type]');
  if (!refEl) return;
  e.preventDefault();

  const refType = refEl.dataset.refType;
  const filename = refEl.dataset.file;

  if (refType === 'comment') {
    const commentIndex = parseInt(refEl.dataset.commentIndex, 10);
    navigateToComment(filename, commentIndex);
  } else if (refType === 'image') {
    navigateToImage(filename);
  }
});
