// ── File Attachments (sidebar "Add your context" input) ──
// Handles attaching project files (via picker modal) or local uploads to
// a comment before it's submitted. Previously part of the chat panel;
// now used only by the per-file sidebar and gallery comment input.

function cropUrl(filePath, region) {
  return `/api/files/${encodeURIComponent(filePath)}/crop?x=${region.x}&y=${region.y}&w=${region.w}&h=${region.h}`;
}

function renderSidebarAttachments() {
  const container = document.getElementById('sidebar-attachments');
  if (!container) return;
  if (sidebarAttachments.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  container.innerHTML = sidebarAttachments.map((att, i) => {
    const label = att.type === 'project' ? att.path.split('/').pop() : att.name;
    return `<div class="chat-attachment-thumb"><img src="${att.thumbUrl}"><button class="remove-attachment" data-att-idx="${i}">&times;</button><div class="chat-attachment-label">${escapeHtml(label)}</div></div>`;
  }).join('');
  container.querySelectorAll('.remove-attachment').forEach(btn => {
    btn.addEventListener('click', () => {
      sidebarAttachments.splice(parseInt(btn.dataset.attIdx), 1);
      renderSidebarAttachments();
    });
  });
}

function addProjectAttachment(filePath, region, label) {
  const key = region ? `${filePath}#${region.x},${region.y},${region.w},${region.h}` : filePath;
  if (sidebarAttachments.find(a => a._key === key)) return; // no duplicates
  const thumbUrl = region ? cropUrl(filePath, region) : `/api/files/${encodeURIComponent(filePath)}/thumb`;
  sidebarAttachments.push({
    type: 'project', path: filePath, region: region || null,
    thumbUrl, _key: key, _label: label || filePath.split('/').pop(),
  });
  renderSidebarAttachments();
}

async function showProjectFilePicker() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:200;display:flex;align-items:center;justify-content:center';
  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:0;max-width:600px;width:92%;max-height:75vh;display:flex;flex-direction:column;overflow:hidden';

  modal.innerHTML = `
    <div style="padding:16px 16px 0;flex-shrink:0">
      <div style="font-weight:600;margin-bottom:10px;font-size:14px">Attach project files</div>
      <input type="text" id="pick-search" placeholder="Search files..." style="width:100%;padding:8px 12px;background:var(--bg);border:1px solid var(--border-strong);border-radius:var(--radius);color:var(--text);font-size:13px;font-family:inherit;outline:none;box-sizing:border-box">
    </div>
    <div id="pick-file-list" style="flex:1;overflow-y:auto;padding:12px 16px">
      <div style="color:var(--text-muted);font-size:12px;padding:20px 0;text-align:center">Loading files...</div>
    </div>
    <div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
      <span id="pick-count" style="font-size:11px;color:var(--text-muted)">0 selected</span>
      <div>
        <button class="btn btn-ghost" id="pick-cancel" style="margin-right:8px">Cancel</button>
        <button class="btn btn-primary" id="pick-done">Attach Selected</button>
      </div>
    </div>`;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  let allFiles = [];
  try {
    const res = await api('/api/files-all');
    allFiles = res;
  } catch (e) {
    modal.querySelector('#pick-file-list').innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:20px 0;text-align:center">Failed to load files</div>';
    return;
  }

  const IMAGE_RE = /\.(jpe?g|png|gif|webp)$/i;
  const selected = new Map();

  function renderFileList(filter) {
    const listEl = modal.querySelector('#pick-file-list');
    const q = (filter || '').toLowerCase();
    const filtered = q ? allFiles.filter(f => f.path.toLowerCase().includes(q)) : allFiles;

    if (filtered.length === 0) {
      listEl.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:20px 0;text-align:center">No files match your search</div>';
      return;
    }

    const groups = {};
    filtered.forEach(f => {
      const dir = f.dir || '(root)';
      if (!groups[dir]) groups[dir] = [];
      groups[dir].push(f);
    });

    let html = '';
    for (const [dir, dirFiles] of Object.entries(groups)) {
      html += `<div style="margin-bottom:12px">`;
      html += `<div style="font-size:10px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;padding-left:2px">${escapeHtml(dir)}</div>`;
      html += `<div style="display:flex;flex-wrap:wrap;gap:6px">`;
      dirFiles.forEach(f => {
        const isImage = IMAGE_RE.test(f.name);
        const isSelected = selected.has(f.path);
        const borderColor = isSelected ? 'var(--accent)' : 'transparent';
        if (isImage) {
          html += `<div class="pick-item" data-path="${escapeHtml(f.path)}" data-type="full" style="cursor:pointer;border-radius:8px;overflow:hidden;border:2px solid ${borderColor};transition:border-color 0.15s;width:72px;min-width:72px;flex-shrink:0">
            <img src="/api/files/${encodeURIComponent(f.path)}/thumb" style="width:100%;aspect-ratio:1;object-fit:cover;display:block" loading="lazy">
            <div style="font-size:8px;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-muted)">${escapeHtml(f.name)}</div>
          </div>`;
        } else {
          const icon = f.ext === '.pdf' ? 'ph-file-pdf' : f.ext === '.txt' || f.ext === '.md' ? 'ph-file-text' : 'ph-file';
          html += `<div class="pick-item" data-path="${escapeHtml(f.path)}" data-type="full" style="cursor:pointer;border-radius:8px;overflow:hidden;border:2px solid ${borderColor};transition:border-color 0.15s;width:72px;min-width:72px;flex-shrink:0;background:var(--surface-2)">
            <div style="width:100%;aspect-ratio:1;display:flex;align-items:center;justify-content:center"><i class="ph ${icon}" style="font-size:24px;color:var(--text-muted)"></i></div>
            <div style="font-size:8px;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-muted)">${escapeHtml(f.name)}</div>
          </div>`;
        }
      });
      html += `</div></div>`;
    }
    listEl.innerHTML = html;

    listEl.querySelectorAll('.pick-item').forEach(el => {
      el.addEventListener('click', () => {
        const p = el.dataset.path;
        if (selected.has(p)) {
          selected.delete(p);
          el.style.borderColor = 'transparent';
        } else {
          selected.set(p, { path: p, region: null });
          el.style.borderColor = 'var(--accent)';
        }
        modal.querySelector('#pick-count').textContent = `${selected.size} selected`;
      });
    });
  }

  renderFileList('');

  const searchInput = modal.querySelector('#pick-search');
  searchInput.addEventListener('input', () => renderFileList(searchInput.value));
  searchInput.focus();

  modal.querySelector('#pick-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  modal.querySelector('#pick-done').addEventListener('click', () => {
    selected.forEach(({ path, region }) => addProjectAttachment(path, region, null));
    overlay.remove();
  });
}

// Sidebar attach button menu toggle
document.getElementById('sidebar-attach-btn').addEventListener('click', () => {
  document.getElementById('sidebar-attach-menu').classList.toggle('open');
});
document.addEventListener('click', (e) => {
  const sMenu = document.getElementById('sidebar-attach-menu');
  if (sMenu && !e.target.closest('#sidebar-attach-btn') && !e.target.closest('#sidebar-attach-menu')) {
    sMenu.classList.remove('open');
  }
});

document.getElementById('sidebar-attach-project').addEventListener('click', () => {
  document.getElementById('sidebar-attach-menu').classList.remove('open');
  showProjectFilePicker();
});

document.getElementById('sidebar-attach-upload').addEventListener('click', () => {
  document.getElementById('sidebar-attach-menu').classList.remove('open');
  document.getElementById('sidebar-file-upload').click();
});

document.getElementById('sidebar-file-upload').addEventListener('change', (e) => {
  const fileList = e.target.files;
  if (!fileList) return;
  Array.from(fileList).forEach(file => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      const thumbUrl = reader.result;
      sidebarAttachments.push({ type: 'upload', data: base64, mediaType: file.type || 'image/png', name: file.name, thumbUrl });
      renderSidebarAttachments();
    };
    reader.readAsDataURL(file);
  });
  e.target.value = '';
});
