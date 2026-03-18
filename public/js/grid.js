// grid.js — extracted from index.html

function onlyFiles() {
  return files.filter(f => f.type === 'file');
}

function onlyDirs() {
  return files.filter(f => f.type === 'directory');
}

function filteredFiles() {
  let result = onlyFiles();
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    result = result.filter(f =>
      f.name.toLowerCase().includes(q) ||
      (f.comments || []).some(c => c.text.toLowerCase().includes(q))
    );
  }
  return result;
}

function updateProgress() {
  // No-op: status tracking removed
}

// ── Grid View ──
function renderGrid() {
  const grid = document.getElementById('grid');
  const dirs = onlyDirs();
  const visible = filteredFiles();

  // Render directories first
  const dirHtml = dirs.map(d => `
    <div class="grid-item folder" onclick="navigateToDir('${escapeAttr(d.path)}')">
      <div class="grid-thumb-placeholder">\u{1F4C1}</div>
      <div class="grid-info">
        <div class="grid-name">${escapeHtml(d.name)}</div>
        <div class="grid-meta">${d.fileCount} file${d.fileCount !== 1 ? 's' : ''}${d.dirCount ? ` \u00B7 ${d.dirCount} folder${d.dirCount !== 1 ? 's' : ''}` : ''}</div>
      </div>
    </div>
  `).join('');

  const fileHtml = visible.map((file, i) => {
    const isImage = IMAGE_EXTS.includes(file.ext);
    const thumb = isImage
      ? `<img class="grid-thumb" src="/api/files/${encodeURIComponent(file.path)}/thumb" loading="lazy" alt="${file.name}">`
      : `<div class="grid-thumb-placeholder">${FILE_ICONS[file.ext] || '\u{1F4CE}'}</div>`;
    return `
      <div class="grid-item" data-filename="${escapeAttr(file.path)}" onclick="openFile('${escapeAttr(file.path)}')">
        ${thumb}
        <div class="grid-info">
          <div class="grid-name">${escapeHtml(file.name)}</div>
          <div class="grid-meta">
            ${file.commentCount ? `${file.commentCount} comment${file.commentCount > 1 ? 's' : ''}` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  grid.innerHTML = dirHtml + fileHtml;
}

async function loadFiles() {
  const dirParam = currentDir ? `?dir=${encodeURIComponent(currentDir)}` : '';
  const allEntries = await api(`/api/files${dirParam}`);
  files = allEntries;
  updateProgress();
  renderGrid();
  renderBreadcrumbs();
  checkOrphans();
}

// Search input listener for grid filtering
document.getElementById('search-input').addEventListener('input', (e) => {
  searchQuery = e.target.value.trim();
  renderGrid();
});
