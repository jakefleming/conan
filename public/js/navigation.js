// navigation.js — extracted from index.html

async function loadConfig() {
  const config = await api('/api/config');
  currentFolder = config.folder;
  recentFolders = config.recentFolders || [];
  // Make sure current folder is in recents
  if (!recentFolders.includes(currentFolder)) {
    recentFolders.unshift(currentFolder);
  }
  updateFolderDisplay();
}

function updateFolderDisplay() {
  const el = document.getElementById('folder-path');
  // Show just text, preserve the dropdown child
  const dropdown = document.getElementById('folder-dropdown');
  el.childNodes.forEach(n => { if (n !== dropdown) n.remove(); });
  el.insertBefore(document.createTextNode(currentFolder), dropdown);
}

function renderFolderDropdown() {
  const dropdown = document.getElementById('folder-dropdown');
  let html = '';
  if (recentFolders.length > 0) {
    html += '<div class="folder-dropdown-header">Recent Projects</div>';
    recentFolders.forEach(f => {
      const isActive = f === currentFolder;
      html += `<button class="folder-dropdown-item${isActive ? ' active' : ''}" data-folder="${escapeHtml(f)}">
        <i class="ph ${isActive ? 'ph-folder-open' : 'ph-folder'}"></i>
        <span class="folder-item-path">${escapeHtml(f)}</span>
      </button>`;
    });
  }
  html += '<div class="folder-dropdown-divider"></div>';
  html += `<button class="folder-dropdown-item" id="folder-browse">
    <i class="ph ph-folder-plus"></i>
    <span>Browse for folder...</span>
  </button>`;
  dropdown.innerHTML = html;

  // Bind click handlers
  dropdown.querySelectorAll('[data-folder]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const folder = btn.dataset.folder;
      if (folder === currentFolder) { dropdown.classList.remove('open'); return; }
      await switchFolder(folder);
    });
  });
  dropdown.querySelector('#folder-browse').addEventListener('click', async (e) => {
    e.stopPropagation();
    dropdown.classList.remove('open');
    await browseForFolder();
  });
}

async function switchFolder(folder) {
  const res = await api('/api/folder/switch', { method: 'POST', body: { folder } });
  if (res.error) { alert('Error: ' + res.error); return; }
  currentFolder = res.folder;
  recentFolders = recentFolders.filter(f => f !== currentFolder);
  recentFolders.unshift(currentFolder);
  updateFolderDisplay();
  document.getElementById('folder-dropdown').classList.remove('open');
  // Reset UI state
  currentDir = '';
  await loadFiles();
  exitGallery();
}

async function browseForFolder() {
  const res = await api('/api/folder/browse', { method: 'POST' });
  if (res.cancelled) return;
  if (res.error) { alert('Error: ' + res.error); return; }
  currentFolder = res.folder;
  recentFolders = recentFolders.filter(f => f !== currentFolder);
  recentFolders.unshift(currentFolder);
  updateFolderDisplay();
  // Reset UI state
  currentDir = '';
  await loadFiles();
  exitGallery();
}

function navigateToDir(dir) {
  // Save scroll position on current state before navigating
  if (!_navFromPopstate) {
    const scrollTop = getScrollTop();
    navReplaceState(currentDir, galleryMode ? onlyFiles()[currentIndex]?.path : null, scrollTop);
  }
  currentDir = dir;
  if (!_navFromPopstate) navPushState(dir, null, 0);
  loadFiles();
  // Reset summary state for new directory
  summaryRawContent = '';
  summaryLastModified = null;
  summaryCurrentVersion = null;
  summaryTotalVersions = 0;
  if (summaryVisible) {
    renderSummary(); // immediately show empty state for the new dir
    loadSummary();
    loadVersionList();
  }
}

function renderBreadcrumbs() {
  const bar = document.getElementById('breadcrumb-bar');
  if (!currentDir) {
    bar.innerHTML = '<span class="breadcrumb-item current">Root</span>';
    return;
  }
  const parts = currentDir.split('/');
  let html = '<span class="breadcrumb-item" onclick="navigateToDir(\'\')">Root</span>';
  let accumulated = '';
  parts.forEach((part, i) => {
    accumulated = accumulated ? accumulated + '/' + part : part;
    const isLast = i === parts.length - 1;
    html += `<span class="breadcrumb-sep">/</span>`;
    if (isLast) {
      html += `<span class="breadcrumb-item current">${escapeHtml(part)}</span>`;
    } else {
      const dir = accumulated;
      html += `<span class="breadcrumb-item" onclick="navigateToDir('${escapeAttr(dir)}')">${escapeHtml(part)}</span>`;
    }
  });
  bar.innerHTML = html;
}

async function checkOrphans() {
  try {
    const dirParam = currentDir ? `?dir=${encodeURIComponent(currentDir)}` : '';
    const res = await api(`/api/orphans${dirParam}`);
    orphanCount = res.count || 0;
    const banner = document.getElementById('orphan-banner');
    if (orphanCount > 0) {
      document.getElementById('orphan-text').textContent = `${orphanCount} annotation${orphanCount > 1 ? 's don\'t' : ' doesn\'t'} match any file in this folder.`;
      banner.classList.add('active');
    } else {
      banner.classList.remove('active');
    }
  } catch {}
}

async function reconcileFiles() {
  const btn = document.getElementById('btn-reconcile');
  btn.disabled = true;
  btn.textContent = 'Reconciling...';
  try {
    const res = await api('/api/reconcile', { method: 'POST' });
    if (res.migrated?.length > 0) {
      showToast(`📎 Reconnected ${res.migrated.length} file${res.migrated.length > 1 ? 's' : ''}`, 'success');
    } else if (res.stillOrphaned > 0) {
      const clean = confirm(`No matching files found for ${res.stillOrphaned} orphaned annotation(s). Remove them?`);
      if (clean) {
        const dirParam = currentDir ? `?dir=${encodeURIComponent(currentDir)}` : '';
        await api(`/api/orphans/clean${dirParam}`, { method: 'POST' });
        showToast('Cleaned orphaned annotations', 'success');
      }
    } else {
      showToast('No orphaned annotations found', 'info');
    }
    loadFiles();
  } catch (e) {
    showToast('Reconcile failed: ' + e.message, 'info');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reconcile';
  }
}

// ── Check for auto-reconcile results on load ──
async function checkReconcileNotifications() {
  try {
    const res = await api('/api/reconcile/last');
    if (res && res.migrated?.length > 0) {
      const count = res.migrated.length;
      showToast(`📎 ${count} file${count > 1 ? 's' : ''} reconnected after move/rename`, 'success', 6000);
    }
  } catch {}
}

// ── Rename file ──
function startRename() {
  const fileItems = onlyFiles();
  if (!fileItems[currentIndex]) return;
  const file = fileItems[currentIndex];
  const el = document.getElementById('sidebar-filename');
  const currentName = file.name;
  el.classList.add('editing');
  el.innerHTML = `<input class="rename-input" id="rename-input" value="${currentName.replace(/"/g, '&quot;')}" />`;
  const input = document.getElementById('rename-input');
  // Select the name part without extension
  const dotIndex = currentName.lastIndexOf('.');
  input.focus();
  if (dotIndex > 0) {
    input.setSelectionRange(0, dotIndex);
  } else {
    input.select();
  }
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      await finishRename(input.value.trim(), file);
    } else if (e.key === 'Escape') {
      cancelRename(file);
    }
  });
  input.addEventListener('blur', () => {
    // Small delay to allow Enter handler to fire first
    setTimeout(() => {
      if (document.getElementById('rename-input')) {
        cancelRename(file);
      }
    }, 150);
  });
}

function cancelRename(file) {
  const el = document.getElementById('sidebar-filename');
  el.classList.remove('editing');
  el.textContent = file.name;
}

async function finishRename(newName, file) {
  const el = document.getElementById('sidebar-filename');
  el.classList.remove('editing');
  if (!newName || newName === file.name) {
    el.textContent = file.name;
    return;
  }
  try {
    const res = await api(`/api/files/${encodeURIComponent(file.path)}/rename`, {
      method: 'PUT',
      body: { newName },
    });
    if (res.error) {
      showToast(res.error, 'info');
      el.textContent = file.name;
      return;
    }
    showToast(`Renamed to ${newName}`, 'success');
    await reloadCurrentDir();
    // Find and navigate to the renamed file
    const newFiles = onlyFiles();
    const newIndex = newFiles.findIndex(f => f.name === newName);
    if (newIndex >= 0) {
      currentIndex = newIndex;
      showDetail(newIndex);
    }
  } catch (e) {
    showToast('Rename failed: ' + e.message, 'info');
    el.textContent = file.name;
  }
}
