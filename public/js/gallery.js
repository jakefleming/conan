// gallery.js — extracted from index.html

function openFile(filePath) {
  const idx = onlyFiles().findIndex(f => f.path === filePath);
  if (idx === -1) return;
  currentIndex = idx;
  enterGallery();
}

function enterGallery(onRendered) {
  galleryMode = true;
  document.getElementById('overview-container').classList.add('hidden');
  document.getElementById('gallery').classList.add('active');
  document.getElementById('breadcrumb-bar').style.display = 'none';
  document.getElementById('orphan-banner').classList.remove('active');
  document.getElementById('btn-toggle-summary').style.display = 'none';
  updateChatFabVisibility();
  renderGalleryItem().then(() => {
    if (onRendered) onRendered();
  });
}

function exitGallery() {
  galleryMode = false;
  document.getElementById('overview-container').classList.remove('hidden');
  document.getElementById('gallery').classList.remove('active');
  document.getElementById('breadcrumb-bar').style.display = '';
  document.getElementById('btn-toggle-summary').style.display = '';
  updateChatFabVisibility();
  loadFiles();
}

async function renderGalleryItem() {
  selectedRegionIndex = null;
  const fileItems = onlyFiles();
  if (!fileItems[currentIndex]) return;
  const file = fileItems[currentIndex];
  const isImage = IMAGE_EXTS.includes(file.ext);

  // Reset annotation state on navigation
  stagedRegion = null;
  drawingRegion = null;
  hoveredCommentRegion = null;
  focusedCommentIndex = null;
  editingRegionIndex = null;
  editDragType = null;
  editStartMouse = null;
  editStartRegion = null;

  // Preview
  const previewEl = document.getElementById('preview-content');
  if (isImage) {
    previewEl.innerHTML = `<div class="zoom-container" id="zoom-container"><img src="/api/files/${encodeURIComponent(file.path)}/preview" alt="${file.name}" id="zoom-img"><svg class="region-overlay" id="region-overlay"></svg></div>`;
    initZoom();
  } else if (file.ext === '.pdf') {
    previewEl.innerHTML = `<iframe src="/api/files/${encodeURIComponent(file.path)}/preview" style="width:100%;height:100%;border:none;border-radius:4px"></iframe>`;
  } else if (SPREADSHEET_EXTS.includes(file.ext)) {
    previewEl.innerHTML = `<div class="spreadsheet-preview" id="spreadsheet-container"></div>`;
    renderSpreadsheet(file.path, document.getElementById('spreadsheet-container'));
  } else if (TEXT_EXTS.includes(file.ext)) {
    previewEl.innerHTML = `<div class="text-preview"><pre>Loading...</pre></div>`;
    fetch(`/api/files/${encodeURIComponent(file.path)}/preview`)
      .then(r => r.text())
      .then(text => {
        const pre = previewEl.querySelector('pre');
        if (pre) pre.textContent = text;
      });
  } else {
    previewEl.innerHTML = `<div class="file-placeholder"><div class="icon">${FILE_ICONS[file.ext] || '\u{1F4CE}'}</div><div class="name">${file.name}</div></div>`;
  }

  // Sidebar info
  document.getElementById('sidebar-filename').textContent = file.name;

  // Load comments from file data we already have
  renderComments(file.path, file);

  // Clear input
  document.getElementById('comment-input').value = '';
}

// Light refresh: only update sidebar comments + region overlay without rebuilding the image
function refreshSidebar() {
  const fileItems = onlyFiles();
  if (!fileItems[currentIndex]) return;
  const file = fileItems[currentIndex];
  document.getElementById('sidebar-filename').textContent = file.name;
  renderComments(file.path, file);
  renderRegionOverlay();
}

// filename param is now a relative path (file.path)
function renderComments(filename, fileCtx) {
  const list = document.getElementById('comments-list');
  if (!fileCtx || fileCtx.comments.length === 0) {
    list.innerHTML = '<div class="no-comments">No comments yet. Add context for this file.</div>';
    return;
  }
  const editSvg = `<i class="ph ph-pencil-simple" style="font-size:14px"></i>`;
  const fixSvg = `<i class="ph ph-magic-wand" style="font-size:14px"></i>`;

  list.innerHTML = fileCtx.comments.map((c, i) => {
    const regionData = c.region ? `data-region='${JSON.stringify(c.region)}'` : '';
    const regionLabel = c.region ? `<span class="region-indicator" title="Has region annotation">#${i + 1} ⬒</span>` : '';
    return `
    <div class="comment" id="comment-${encodeURIComponent(filename)}-${i}" ${regionData}>
      <div class="comment-actions">
        <button class="comment-action-btn edit" data-idx="${i}" title="Edit">${editSvg}</button>
        <button class="comment-action-btn fix" data-idx="${i}" title="Fix formatting with Claude">${fixSvg}</button>
        <button class="comment-action-btn delete" data-idx="${i}" title="Delete">&times;</button>
      </div>
      <div class="comment-author ${c.author}">${c.author}${regionLabel}</div>
      <div class="comment-text" data-comment-idx="${i}">${escapeHtml(c.text)}</div>
      ${c.audio ? `<audio controls preload="none" style="width:100%;height:28px;margin-top:6px;border-radius:4px"><source src="/api/audio/${encodeURIComponent(c.audio)}" type="audio/webm"></audio>` : ''}
      ${c.attachments && c.attachments.length > 0 ? `<div class="comment-attachments">${c.attachments.map(att => {
        const isImage = /\.(jpe?g|png|gif|webp)$/i.test(att.path || att.originalName || '');
        const name = att.type === 'project' ? att.path.split('/').pop() : (att.originalName || att.path.split('/').pop());
        const thumbSrc = att.type === 'project'
          ? '/api/files/' + encodeURIComponent(att.path) + '/thumb'
          : '/api/attachments/' + encodeURIComponent(att.path);
        const icon = isImage ? '' : '<i class="ph ph-file" style="font-size:14px"></i>';
        const img = isImage ? `<img src="${thumbSrc}" class="comment-att-img">` : icon;
        return `<div class="comment-att-chip" data-att-type="${att.type}" data-att-path="${escapeHtml(att.path)}" title="${escapeHtml(name)}">${img}<span class="comment-att-name">${escapeHtml(name)}</span></div>`;
      }).join('')}</div>` : ''}
      <div class="comment-time">${new Date(c.ts).toLocaleString()}</div>
    </div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;

  // Delete buttons
  list.querySelectorAll('.comment-action-btn.delete').forEach(btn => {
    btn.addEventListener('click', () => deleteComment(filename, parseInt(btn.dataset.idx, 10)));
  });

  // Edit buttons
  list.querySelectorAll('.comment-action-btn.edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const comment = fileCtx.comments[idx];
      if (!comment) return;
      const textEl = list.querySelector(`.comment-text[data-comment-idx="${idx}"]`);
      if (!textEl || textEl.querySelector('textarea')) return;

      // Replace text with textarea at same size
      const ta = document.createElement('textarea');
      ta.className = 'comment-text-edit';
      ta.value = comment.text;
      // Match the height of the original text
      const origHeight = textEl.offsetHeight;
      textEl.textContent = '';
      textEl.appendChild(ta);
      ta.style.height = Math.max(40, origHeight) + 'px';
      ta.focus();

      // Add save/cancel buttons
      const actions = document.createElement('div');
      actions.className = 'comment-edit-actions';
      actions.innerHTML = '<button class="btn-save">Save</button><button class="btn-cancel">Cancel</button>';
      textEl.parentNode.insertBefore(actions, textEl.nextSibling);

      const cancel = () => {
        actions.remove();
        textEl.textContent = comment.text;
      };
      const save = async () => {
        const newText = ta.value.trim();
        if (newText && newText !== comment.text) {
          comment.text = newText;
          try {
            await api(`/api/files/${encodeURIComponent(filename)}/comments/${idx}/text`, {
              method: 'PUT',
              body: { text: newText },
            });
          } catch (err) {
            console.error('Failed to save comment edit:', err);
          }
        }
        actions.remove();
        textEl.textContent = comment.text;
      };

      actions.querySelector('.btn-save').addEventListener('click', save);
      actions.querySelector('.btn-cancel').addEventListener('click', cancel);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
      });
    });
  });

  // Fix formatting buttons (Claude) — with undo
  const undoSvg = `<i class="ph ph-arrow-counter-clockwise" style="font-size:14px"></i>`;
  list.querySelectorAll('.comment-action-btn.fix').forEach(btn => {
    let preFixText = null;
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const comment = fileCtx.comments[idx];
      if (!comment) return;
      const textEl = list.querySelector(`.comment-text[data-comment-idx="${idx}"]`);

      // If we have a stashed original, this click is an undo
      if (preFixText !== null) {
        const revertText = preFixText;
        preFixText = null;
        comment.text = revertText;
        if (textEl) textEl.textContent = revertText;
        btn.innerHTML = fixSvg;
        btn.title = 'Fix formatting with Claude';
        try {
          await api(`/api/files/${encodeURIComponent(filename)}/comments/${idx}/text`, {
            method: 'PUT',
            body: { text: revertText },
          });
        } catch (err) {
          console.error('Failed to revert comment:', err);
        }
        return;
      }

      // Otherwise, fix with Claude
      if (!hasApiKey) {
        document.getElementById('btn-settings').click();
        return;
      }
      preFixText = comment.text;
      btn.classList.add('loading');
      btn.style.opacity = '1';

      // Add loading state to the comment card
      const commentEl = btn.closest('.comment');
      if (commentEl) commentEl.classList.add('fixing');

      // Insert spinner below text
      const spinnerEl = document.createElement('div');
      spinnerEl.className = 'comment-fix-spinner';
      spinnerEl.innerHTML = `<i class="ph ph-spinner" style="font-size:14px;animation:spin 1s linear infinite"></i> Fixing with Claude…`;
      if (textEl) textEl.parentNode.insertBefore(spinnerEl, textEl.nextSibling);

      try {
        const res = await api(`/api/files/${encodeURIComponent(filename)}/comments/${idx}/fix`, { method: 'POST' });
        if (res.text) {
          comment.text = res.text;
          if (textEl) textEl.textContent = res.text;
          // Swap to undo icon
          btn.innerHTML = undoSvg;
          btn.title = 'Undo fix';
        } else {
          preFixText = null; // fix failed, clear stash
        }
      } catch (err) {
        console.error('Failed to fix comment:', err);
        preFixText = null;
      } finally {
        btn.classList.remove('loading');
        btn.style.opacity = '';
        if (commentEl) commentEl.classList.remove('fixing');
        if (spinnerEl.parentNode) spinnerEl.remove();
      }
    });
  });

  // Attach hover listeners for region focus (dims others, highlights this one)
  list.querySelectorAll('.comment[data-region]').forEach((el, _, all) => {
    const idx = parseInt(el.id.split('-').pop(), 10);
    el.addEventListener('mouseenter', () => {
      focusedCommentIndex = idx;
      highlightSidebarComment(idx);
      renderRegionOverlay();
    });
    el.addEventListener('mouseleave', () => {
      focusedCommentIndex = null;
      highlightSidebarComment(null);
      renderRegionOverlay();
    });
  });

  // Right-click "Send to Chat" on comments with regions
  list.querySelectorAll('.comment[data-region]').forEach(el => {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const idx = parseInt(el.id.split('-').pop(), 10);
      const comment = fileCtx.comments[idx];
      if (!comment || !comment.region) return;
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Send crop to Chat', icon: 'sparkle', action: () => {
          addProjectAttachment(filename, comment.region, `#${idx+1} crop`);
          if (!chatOpen) toggleChat();
        }},
        { label: 'Send full image to Chat', icon: 'image', action: () => {
          addProjectAttachment(filename, null, filename.split('/').pop());
          if (!chatOpen) toggleChat();
        }},
      ]);
    });
  });

  // Right-click "Send to Chat" on comments without regions (send full image)
  list.querySelectorAll('.comment:not([data-region])').forEach(el => {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Send image to Chat', icon: 'image', action: () => {
          addProjectAttachment(filename, null, filename.split('/').pop());
          if (!chatOpen) toggleChat();
        }},
      ]);
    });
  });

  // Attachment chip click handlers
  list.querySelectorAll('.comment-att-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const type = chip.dataset.attType;
      const path = chip.dataset.attPath;
      if (type === 'project') {
        // Navigate to that file in the gallery
        const fileItems = onlyFiles();
        const idx = fileItems.findIndex(f => f.path === path || f.name === path);
        if (idx >= 0) {
          currentIndex = idx;
          renderGalleryItem();
        } else {
          // Might be in a different directory — try navigating
          const parts = path.split('/');
          if (parts.length > 1) {
            const dir = parts.slice(0, -1).join('/');
            const fileName = parts[parts.length - 1];
            currentDir = dir;
            reloadCurrentDir().then(() => {
              enterGallery();
              const newFiles = onlyFiles();
              const newIdx = newFiles.findIndex(f => f.name === fileName);
              if (newIdx >= 0) { currentIndex = newIdx; renderGalleryItem(); }
            });
          }
        }
      } else {
        // Open local attachment in new tab
        window.open('/api/attachments/' + encodeURIComponent(path), '_blank');
      }
    });
  });
}

async function reloadCurrentDir() {
  const dirParam = currentDir ? `?dir=${encodeURIComponent(currentDir)}` : '';
  files = await api(`/api/files${dirParam}`);
  updateProgress();
}

async function addComment() {
  const input = document.getElementById('comment-input');
  const text = input.value.trim();
  if (!text && sidebarAttachments.length === 0) return;
  const file = onlyFiles()[currentIndex];
  const body = { author: 'user', text: text || '' };
  if (lastAudioFilename) body.audio = lastAudioFilename;
  if (stagedRegion) body.region = stagedRegion;

  // Process sidebar attachments
  if (sidebarAttachments.length > 0) {
    const attachments = [];
    for (const att of sidebarAttachments) {
      if (att.type === 'project') {
        attachments.push({ type: 'project', path: att.path });
      } else if (att.type === 'upload') {
        // Upload external file to .attachments/ first
        const res = await api('/api/attachments/upload', {
          method: 'POST',
          body: { dir: currentDir, data: att.data, name: att.name, mediaType: att.mediaType }
        });
        if (res.path) {
          attachments.push({ type: 'local', path: res.path, originalName: att.name });
        }
      }
    }
    if (attachments.length > 0) body.attachments = attachments;
  }

  await api(`/api/files/${encodeURIComponent(file.path)}/comments`, {
    method: 'POST',
    body,
  });
  input.value = '';
  lastAudioFilename = null;
  stagedRegion = null;
  sidebarAttachments = [];
  renderSidebarAttachments();
  updateStagedRegionUI();
  renderRegionOverlay();
  await reloadCurrentDir();
  refreshSidebar();
}

async function deleteComment(filename, index) {
  await api(`/api/files/${encodeURIComponent(filename)}/comments/${index}`, {
    method: 'DELETE',
  });
  await reloadCurrentDir();
  refreshSidebar();
}

function goNext() {
  const fileItems = onlyFiles();
  if (currentIndex < fileItems.length - 1) {
    currentIndex++;
    renderGalleryItem();
  }
}

function goPrev() {
  if (currentIndex > 0) {
    currentIndex--;
    renderGalleryItem();
  }
}

function startAddContext() {
  currentIndex = 0;
  enterGallery();
}

// ── Summary Reference Navigation ──
// filePath can be a relative path like "subdir/IMG_5210.jpeg" or just "IMG_5210.jpeg"
async function navigateToComment(filePath, commentIndex) {
  // If file is in a different directory, navigate there first
  const parts = filePath.split('/');
  const fileDir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  if (fileDir !== currentDir) {
    navigateToDir(fileDir);
    // Wait for files to load
    await new Promise(r => setTimeout(r, 300));
  }

  const fileItems = onlyFiles();
  let fileIdx = fileItems.findIndex(f => f.path === filePath);
  if (fileIdx === -1) fileIdx = fileItems.findIndex(f => f.name === filePath);
  // Also try matching just the basename (for summaries that use bare filenames)
  if (fileIdx === -1) {
    const baseName = parts[parts.length - 1];
    fileIdx = fileItems.findIndex(f => f.name === baseName);
  }
  if (fileIdx === -1) {
    showRefError('File not found: ' + filePath);
    return;
  }
  currentIndex = fileIdx;
  enterGallery(() => {
    const commentId = 'comment-' + encodeURIComponent(fileItems[fileIdx].path) + '-' + commentIndex;
    const commentEl = document.getElementById(commentId);
    if (commentEl) {
      commentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      commentEl.classList.add('highlight-flash');
      commentEl.addEventListener('animationend', () => {
        commentEl.classList.remove('highlight-flash');
      }, { once: true });
    } else {
      showRefError('Comment #' + commentIndex + ' not found on ' + filePath);
    }
  });
}

async function navigateToImage(filePath) {
  // If file is in a different directory, navigate there first
  const parts = filePath.split('/');
  const fileDir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  if (fileDir !== currentDir) {
    navigateToDir(fileDir);
    await new Promise(r => setTimeout(r, 300));
  }

  const fileItems = onlyFiles();
  let fileIdx = fileItems.findIndex(f => f.path === filePath);
  if (fileIdx === -1) fileIdx = fileItems.findIndex(f => f.name === filePath);
  if (fileIdx === -1) {
    const baseName = parts[parts.length - 1];
    fileIdx = fileItems.findIndex(f => f.name === baseName);
  }
  // If not found, try resolving via alias table (renamed/moved files)
  if (fileIdx === -1) {
    try {
      const baseName = parts[parts.length - 1];
      // Try full path first, then just filename
      const queries = [filePath, baseName];
      for (const q of queries) {
        const res = await fetch('/api/index/find-file?q=' + encodeURIComponent(q));
        if (!res.ok) continue;
        const { results } = await res.json();
        if (!results || results.length === 0) continue;
        const match = results[0];
        const matchPath = match.file_path;
        const matchDir = matchPath.includes('/') ? matchPath.substring(0, matchPath.lastIndexOf('/')) : '';
        if (matchDir !== currentDir) {
          navigateToDir(matchDir);
          await new Promise(r => setTimeout(r, 300));
        }
        const newFileItems = onlyFiles();
        const matchName = matchPath.split('/').pop();
        fileIdx = newFileItems.findIndex(f => f.name === matchName || f.path === matchPath);
        if (fileIdx !== -1) break;
      }
    } catch (e) { /* index search failed, fall through to error */ }
  }
  if (fileIdx === -1) {
    showRefError('File not found: ' + filePath);
    return;
  }
  currentIndex = fileIdx;
  enterGallery();
}
