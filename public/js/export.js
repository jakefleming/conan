// ── Export Functions ──
// Extracted from index.html: export annotations as zip

async function exportAnnotations(scope, path) {
  const btn = document.getElementById('btn-export');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Exporting...';
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, path }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Export failed');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const disposition = res.headers.get('Content-Disposition') || '';
    a.download = disposition.match(/filename="(.+)"/)?.[1] || 'export.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Export failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
    document.getElementById('export-dropdown').style.display = 'none';
  }
}

document.getElementById('btn-export').addEventListener('click', () => {
  const dd = document.getElementById('export-dropdown');
  const isOpen = dd.style.display !== 'none';
  dd.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    // Show "This Image" only when viewing a file in gallery mode
    const fileOpt = document.getElementById('export-file');
    fileOpt.style.display = galleryMode ? 'block' : 'none';
    // Update dir label
    const dirOpt = document.getElementById('export-dir');
    dirOpt.textContent = currentDir ? `This Directory (${currentDir})` : 'This Directory (root)';
  }
});

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  const wrapper = document.querySelector('.export-wrapper');
  if (wrapper && !wrapper.contains(e.target)) {
    document.getElementById('export-dropdown').style.display = 'none';
  }
});

document.getElementById('export-file').addEventListener('click', () => {
  const file = onlyFiles()[currentIndex];
  if (file) exportAnnotations('file', file.path);
});
document.getElementById('export-dir').addEventListener('click', () => {
  exportAnnotations('directory', currentDir);
});
document.getElementById('export-root').addEventListener('click', () => {
  exportAnnotations('root', '');
});
