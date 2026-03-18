// ── Chat Panel ──

function loadChatSessions() {
  try {
    chatSessions = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || '[]');
  } catch { chatSessions = []; }
}

function saveChatSessions() {
  // Update active session
  if (activeChatId) {
    const s = chatSessions.find(c => c.id === activeChatId);
    if (s) {
      s.messages = chatHistory;
      s.ts = Date.now();
    }
  }
  localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatSessions));
}

function newChat() {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const session = { id, title: 'New chat', messages: [], ts: Date.now() };
  chatSessions.unshift(session);
  activeChatId = id;
  chatHistory = session.messages;
  saveChatSessions();
  renderChatMessages();
  renderChatHistoryBar();
  document.getElementById('chat-input').focus();
}

function switchChat(id) {
  saveChatSessions(); // save current first
  const s = chatSessions.find(c => c.id === id);
  if (!s) return;
  activeChatId = id;
  chatHistory = s.messages;
  renderChatMessages();
  renderChatHistoryBar();
}

function deleteChat(id) {
  chatSessions = chatSessions.filter(c => c.id !== id);
  if (activeChatId === id) {
    if (chatSessions.length > 0) {
      switchChat(chatSessions[0].id);
    } else {
      newChat();
    }
  }
  saveChatSessions();
  renderChatHistoryBar();
}

function renderChatHistoryBar() {
  const bar = document.getElementById('chat-history-bar');
  let html = '<button class="chat-new-btn" id="chat-new-btn" title="New chat">+ New</button>';
  chatSessions.forEach(s => {
    const active = s.id === activeChatId ? ' active' : '';
    const label = escapeHtml(s.title);
    html += `<button class="chat-history-btn${active}" data-chat-id="${s.id}" title="${label}">${label}</button>`;
  });
  if (activeChatId && chatHistory.length > 0) {
    html += `<button class="chat-delete-chat" data-delete-id="${activeChatId}" title="Delete this chat">&times;</button>`;
  }
  bar.innerHTML = html;

  // Re-bind new chat button
  document.getElementById('chat-new-btn').addEventListener('click', newChat);
  // Bind history buttons
  bar.querySelectorAll('.chat-history-btn').forEach(btn => {
    btn.addEventListener('click', () => switchChat(btn.dataset.chatId));
  });
  // Bind delete
  const delBtn = bar.querySelector('.chat-delete-chat');
  if (delBtn) delBtn.addEventListener('click', () => deleteChat(delBtn.dataset.deleteId));
}

function closeChatInstant() {
  saveChatSessions();
  chatOpen = false;
  const panel = document.getElementById('chat-panel');
  panel.classList.remove('open');
  document.body.classList.remove('chat-open');
  document.getElementById('btn-chat').style.display = '';
}

function toggleChat() {
  chatOpen = !chatOpen;
  const panel = document.getElementById('chat-panel');
  const chatBtn = document.getElementById('btn-chat');
  if (chatOpen) {
    // Instant swap if summary is open
    if (summaryVisible) {
      const rail = document.getElementById('summary-siderail');
      panel.style.transition = 'none';
      rail.style.transition = 'none';
      closeSummaryInstant();
      panel.classList.add('open');
      document.body.classList.add('chat-open');
      chatBtn.style.display = 'none';
      requestAnimationFrame(() => {
        panel.style.transition = '';
        rail.style.transition = '';
        document.getElementById('chat-input').focus();
      });
    } else {
      panel.classList.add('open');
      document.body.classList.add('chat-open');
      chatBtn.style.display = 'none';
      requestAnimationFrame(() => {
        document.getElementById('chat-input').focus();
      });
    }
    // Load sessions and ensure one exists
    loadChatSessions();
    if (chatSessions.length === 0) {
      newChat();
    } else {
      if (!activeChatId) activeChatId = chatSessions[0].id;
      const s = chatSessions.find(c => c.id === activeChatId);
      if (s) chatHistory = s.messages;
      renderChatMessages();
      renderChatHistoryBar();
    }
  } else {
    saveChatSessions();
    panel.classList.remove('open');
    document.body.classList.remove('chat-open');
    chatBtn.style.display = '';
  }
}

function processChatRefs(html) {
  html = html.replace(/\[\[comment:([^\]#]+)#(\d+)\]\]/g, (_, file, idx) => {
    const encoded = escapeHtml(file);
    return `<a class="chat-ref chat-ref-comment" data-ref-type="comment" data-ref-file="${encoded}" data-ref-idx="${idx}" title="Go to comment #${idx} on ${encoded}"><i class="ph ph-chat-text" style="font-size:10px"></i>${encoded} #${idx}</a>`;
  });
  html = html.replace(/\[\[file:([^\]]+)\]\]/g, (_, file) => {
    const encoded = escapeHtml(file);
    return `<a class="chat-ref chat-ref-file" data-ref-type="file" data-ref-file="${encoded}" title="Open ${encoded}"><i class="ph ph-image" style="font-size:10px"></i>${encoded}</a>`;
  });
  return html;
}

function renderChatMessages() {
  const container = document.getElementById('chat-messages');
  const empty = document.getElementById('chat-empty');
  if (chatHistory.length === 0) {
    if (empty) empty.style.display = '';
    else container.innerHTML = '<div class="chat-empty" id="chat-empty"><div class="chat-empty-icon"><i class="ph ph-sparkle" style="font-size:20px;color:var(--text-muted)"></i></div><div class="chat-empty-title">Ask about your files</div><div class="chat-empty-desc">Chat with Claude about your annotations, patterns, and design decisions.</div><div class="chat-suggestions" id="chat-suggestions"><button class="chat-suggestion">What patterns do you see across annotations?</button><button class="chat-suggestion">Which files still need annotation?</button><button class="chat-suggestion">Summarize the key decisions made so far</button><button class="chat-suggestion">What components have been identified?</button></div></div>';
    // Rebind suggestions
    container.querySelectorAll('.chat-suggestion').forEach(btn => {
      btn.addEventListener('click', () => { document.getElementById('chat-input').value = ''; sendChatMessage(btn.textContent); });
    });
    return;
  }
  if (empty) empty.style.display = 'none';

  const copyIcon = '<i class="ph ph-copy" style="font-size:12px"></i>';
  let html = '';
  chatHistory.forEach((msg, i) => {
    const isError = msg.isError || (msg.role === 'assistant' && (msg.content.startsWith('Error:') || msg.content.startsWith('Failed to reach')));
    if (msg.role === 'user') {
      html += `<div class="chat-msg user" style="animation-delay:${i * 0.03}s">${escapeHtml(msg.content)}</div>`;
    } else if (isError) {
      html += `<div class="chat-msg assistant chat-msg-error" style="animation-delay:${i * 0.03}s">${escapeHtml(msg.content)}</div>`;
    } else {
      let rendered = (typeof marked !== 'undefined') ? marked.parse(msg.content) : escapeHtml(msg.content);
      rendered = processChatRefs(rendered);
      let cardHtml = '';
      if (msg.fileset && msg.fileset.files && msg.fileset.files.length > 0) {
        cardHtml = renderFilesetCard(msg.fileset, i);
      }
      html += `<div class="chat-msg assistant" style="animation-delay:${i * 0.03}s"><div class="chat-msg-rendered">${rendered}</div>${cardHtml}<div class="chat-msg-actions"><button class="chat-copy-btn" data-copy-idx="${i}">${copyIcon} Copy</button></div></div>`;
    }
  });
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function renderFilesetCard(fileset, msgIdx) {
  const { files, description } = fileset;
  const maxThumbs = 4;
  const visible = files.slice(0, maxThumbs);
  const overflow = files.length - maxThumbs;

  let thumbsHtml = files.map((f, idx) => {
    const thumbUrl = `/api/files/${encodeURIComponent(f)}/thumb`;
    const hiddenClass = idx >= maxThumbs ? ' hidden-thumb' : '';
    return `<img class="chat-fileset-thumb${hiddenClass}" src="${thumbUrl}" alt="${escapeHtml(f)}" data-file="${escapeHtml(f)}" onerror="this.style.display='none'">`;
  }).join('');

  if (overflow > 0) {
    thumbsHtml += `<div class="chat-fileset-overflow" data-fileset-toggle="${msgIdx}">+${overflow}</div>`;
  }

  const fileNames = files.map(f => f.replace(/^.*\//, '').replace(/\.[^.]+$/, '')).join(', ');
  const count = files.length;
  const downloadIcon = '<i class="ph ph-download-simple" style="font-size:14px"></i>';

  return `<div class="chat-fileset" data-msg-idx="${msgIdx}">
    <div class="chat-fileset-thumbs">${thumbsHtml}</div>
    <div class="chat-fileset-info">
      <div class="chat-fileset-title">${count} file${count !== 1 ? 's' : ''} — ${escapeHtml(description)}</div>
      <div class="chat-fileset-files">${escapeHtml(fileNames)}</div>
    </div>
    <button class="chat-fileset-download" data-fileset-idx="${msgIdx}">${downloadIcon} Download ${count} file${count !== 1 ? 's' : ''}</button>
  </div>`;
}

async function downloadFileset(fileList, description, btnEl) {
  if (btnEl) { btnEl.classList.add('downloading'); btnEl.innerHTML = '<i class="ph ph-spinner" style="font-size:14px;animation:spin 1s linear infinite"></i> Preparing...'; }
  try {
    const res = await fetch('/api/download-files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: fileList }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Download failed');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const disposition = res.headers.get('Content-Disposition') || '';
    a.download = disposition.match(/filename="(.+)"/)?.[1] || 'files.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Download failed: ' + e.message);
  } finally {
    if (btnEl) {
      btnEl.classList.remove('downloading');
      const count = fileList.length;
      btnEl.innerHTML = `<i class="ph ph-download-simple" style="font-size:14px"></i> Download ${count} file${count !== 1 ? 's' : ''}`;
    }
  }
}

function showChatTyping() {
  const container = document.getElementById('chat-messages');
  const empty = document.getElementById('chat-empty');
  if (empty) empty.style.display = 'none';
  const typing = document.createElement('div');
  typing.className = 'chat-typing';
  typing.id = 'chat-typing';
  typing.innerHTML = '<div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div>';
  container.appendChild(typing);
  container.scrollTop = container.scrollHeight;
}

function removeChatTyping() {
  const el = document.getElementById('chat-typing');
  if (el) el.remove();
}

async function sendChatMessage(text) {
  if (!text || chatSending) return;
  if (!hasApiKey) {
    document.getElementById('btn-settings').click();
    return;
  }

  chatSending = true;
  const sendBtn = document.getElementById('chat-send');
  sendBtn.disabled = true;

  // Capture attachments for this message and clear them
  const msgAttachments = [...chatAttachments];
  chatAttachments = [];
  renderChatAttachments();

  // Display user message with attachment indicators
  const attachLabels = msgAttachments.map(a => a.type === 'project' ? (a.region ? `${a.path} (crop)` : a.path) : a.name);
  const displayText = attachLabels.length > 0
    ? text + '\n\n' + attachLabels.map(l => `\u{1F4CE} ${l}`).join('\n')
    : text;
  chatHistory.push({ role: 'user', content: displayText });

  // Auto-title from first user message
  if (activeChatId) {
    const s = chatSessions.find(c => c.id === activeChatId);
    if (s && s.title === 'New chat') {
      s.title = text.length > 40 ? text.slice(0, 40) + '...' : text;
      renderChatHistoryBar();
    }
  }
  renderChatMessages();
  showChatTyping();

  // Build attachments payload for server
  const apiAttachments = msgAttachments.map(a => {
    if (a.type === 'project') {
      const att = { type: 'project', path: a.path };
      if (a.region) att.region = a.region;
      return att;
    }
    return { type: 'upload', data: a.data, mediaType: a.mediaType, name: a.name };
  });

  try {
    const res = await api('/api/chat', {
      method: 'POST',
      body: {
        message: text,
        history: chatHistory.slice(0, -1),
        dir: currentDir,
        currentFile: document.getElementById('gallery')?.classList.contains('active') ? (onlyFiles()[currentIndex]?.path || '') : '',
        attachments: apiAttachments,
      },
    });

    removeChatTyping();

    if (res.error) {
      let errMsg = res.error;
      if (errMsg.includes('rate_limit') || errMsg.includes('429')) {
        errMsg = 'Rate limited — too many tokens sent too quickly. Wait a moment and try again.';
      } else if (errMsg.includes('overloaded') || errMsg.includes('529')) {
        errMsg = 'Claude is overloaded. Try again in a few seconds.';
      } else {
        // Strip JSON noise, show just the message
        const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]+)"/);
        if (msgMatch) errMsg = msgMatch[1];
      }
      chatHistory.push({ role: 'assistant', content: errMsg, isError: true });
    } else {
      const msg = { role: 'assistant', content: res.reply || '' };
      if (res.fileset) msg.fileset = res.fileset;
      chatHistory.push(msg);
    }
    renderChatMessages();
    saveChatSessions();
  } catch (e) {
    removeChatTyping();
    chatHistory.push({ role: 'assistant', content: 'Failed to reach Claude: ' + e.message });
    renderChatMessages();
    saveChatSessions();
  } finally {
    chatSending = false;
    sendBtn.disabled = false;
  }
}

// ── Context Menu (right-click "Send to Chat") ──
function showContextMenu(x, y, items) {
  // Remove any existing context menu
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  const icons = {
    sparkle: '<i class="ph ph-sparkle" style="font-size:14px"></i>',
    image: '<i class="ph ph-image" style="font-size:14px"></i>',
  };

  items.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'ctx-menu-item';
    btn.innerHTML = (icons[item.icon] || '') + '<span>' + item.label + '</span>';
    btn.addEventListener('click', () => { menu.remove(); item.action(); });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);

  // Adjust if off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  // Close on click outside or Escape
  const close = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escClose); }
  };
  const escClose = (e) => { if (e.key === 'Escape') { menu.remove(); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escClose); } };
  setTimeout(() => { document.addEventListener('mousedown', close); document.addEventListener('keydown', escClose); }, 0);
}

// ── Drag-to-Chat ──
// Make grid items draggable
function setupGridDrag() {
  document.querySelectorAll('.grid-item[data-filename]').forEach(el => {
    const filename = el.dataset.filename;
    if (!/\.(jpe?g|png|gif|webp)$/i.test(filename)) return;
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-conan-file', JSON.stringify({ path: filename }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    // Right-click on grid items
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Send to Chat', icon: 'sparkle', action: () => {
          addProjectAttachment(filename, null, filename.split('/').pop());
          if (!chatOpen) toggleChat();
        }},
      ]);
    });
  });
}

// Drop zone on chat panel
(function setupChatDropZone() {
  const panel = document.getElementById('chat-panel');
  if (!panel) return;
  let dragCounter = 0;

  panel.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    panel.classList.add('drop-hover');
  });
  panel.addEventListener('dragleave', (e) => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; panel.classList.remove('drop-hover'); }
  });
  panel.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    panel.classList.remove('drop-hover');

    // Check for internal conan file drag
    const conanData = e.dataTransfer.getData('application/x-conan-file');
    if (conanData) {
      try {
        const data = JSON.parse(conanData);
        if (data.path) {
          addProjectAttachment(data.path, data.region || null, data.label || data.path.split('/').pop());
        }
      } catch (err) { console.error('Drop parse error:', err); }
      return;
    }

    // Check for external file drops (images from desktop)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      Array.from(e.dataTransfer.files).forEach(file => {
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.split(',')[1];
          chatAttachments.push({ type: 'upload', data: base64, mediaType: file.type, name: file.name, thumbUrl: reader.result });
          renderChatAttachments();
        };
        reader.readAsDataURL(file);
      });
    }
  });
})();

// Hook into renderGrid to set up drag after each render
const _origRenderGrid = renderGrid;
renderGrid = function() {
  _origRenderGrid();
  setupGridDrag();
};

// ── Chat Attachments ──

function renderChatAttachments() {
  const container = document.getElementById('chat-attachments');
  if (chatAttachments.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  container.innerHTML = chatAttachments.map((att, i) => {
    const label = att.type === 'project' ? att.path.split('/').pop() : att.name;
    return `<div class="chat-attachment-thumb"><img src="${att.thumbUrl}"><button class="remove-attachment" data-att-idx="${i}">&times;</button><div class="chat-attachment-label">${escapeHtml(label)}</div></div>`;
  }).join('');
  container.querySelectorAll('.remove-attachment').forEach(btn => {
    btn.addEventListener('click', () => {
      chatAttachments.splice(parseInt(btn.dataset.attIdx), 1);
      renderChatAttachments();
    });
  });
}

function cropUrl(filePath, region) {
  return `/api/files/${encodeURIComponent(filePath)}/crop?x=${region.x}&y=${region.y}&w=${region.w}&h=${region.h}`;
}

function renderSidebarAttachments() {
  const container = document.getElementById('sidebar-attachments');
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

function addProjectAttachment(filePath, region, label, target) {
  const arr = target === 'sidebar' ? sidebarAttachments : chatAttachments;
  const key = region ? `${filePath}#${region.x},${region.y},${region.w},${region.h}` : filePath;
  if (arr.find(a => a._key === key)) return; // no duplicates
  const thumbUrl = region ? cropUrl(filePath, region) : `/api/files/${encodeURIComponent(filePath)}/thumb`;
  arr.push({
    type: 'project', path: filePath, region: region || null,
    thumbUrl, _key: key, _label: label || filePath.split('/').pop(),
  });
  if (target === 'sidebar') renderSidebarAttachments();
  else renderChatAttachments();
}

async function showProjectFilePicker(target) {
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

  // Fetch all files from root
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

    // Group by directory
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

    // Re-bind click handlers
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

  // Search
  const searchInput = modal.querySelector('#pick-search');
  searchInput.addEventListener('input', () => renderFileList(searchInput.value));
  searchInput.focus();

  modal.querySelector('#pick-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  modal.querySelector('#pick-done').addEventListener('click', () => {
    selected.forEach(({ path, region }) => addProjectAttachment(path, region, null, target));
    if (target === 'sidebar') renderSidebarAttachments();
    else renderChatAttachments();
    overlay.remove();
  });
}

// Attach button menu toggle
document.getElementById('chat-attach-btn').addEventListener('click', () => {
  document.getElementById('chat-attach-menu').classList.toggle('open');
});
document.addEventListener('click', (e) => {
  const menu = document.getElementById('chat-attach-menu');
  if (menu && !e.target.closest('.chat-attach-btn') && !e.target.closest('.chat-attach-menu')) {
    menu.classList.remove('open');
  }
  const sMenu = document.getElementById('sidebar-attach-menu');
  if (sMenu && !e.target.closest('#sidebar-attach-btn') && !e.target.closest('#sidebar-attach-menu')) {
    sMenu.classList.remove('open');
  }
});

// Project files option
document.getElementById('chat-attach-project').addEventListener('click', () => {
  document.getElementById('chat-attach-menu').classList.remove('open');
  showProjectFilePicker('chat');
});

// Upload option
document.getElementById('chat-attach-upload').addEventListener('click', () => {
  document.getElementById('chat-attach-menu').classList.remove('open');
  document.getElementById('chat-file-upload').click();
});
document.getElementById('chat-file-upload').addEventListener('change', (e) => {
  const fileList = e.target.files;
  if (!fileList) return;
  Array.from(fileList).forEach(file => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      const thumbUrl = reader.result;
      chatAttachments.push({ type: 'upload', data: base64, mediaType: file.type || 'image/png', name: file.name, thumbUrl });
      renderChatAttachments();
    };
    reader.readAsDataURL(file);
  });
  e.target.value = ''; // reset so same file can be picked again
});

// Sidebar attach button menu toggle
document.getElementById('sidebar-attach-btn').addEventListener('click', () => {
  document.getElementById('sidebar-attach-menu').classList.toggle('open');
});
document.getElementById('sidebar-attach-project').addEventListener('click', () => {
  document.getElementById('sidebar-attach-menu').classList.remove('open');
  showProjectFilePicker('sidebar');
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

// Topbar chat button
document.getElementById('btn-chat').addEventListener('click', toggleChat);
document.getElementById('chat-close-btn').addEventListener('click', toggleChat);

// Send button
document.getElementById('chat-send').addEventListener('click', () => {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = '';
  sendChatMessage(text);
});

// Enter to send (Shift+Enter for newline)
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = e.target.value.trim();
    if (!text) return;
    e.target.value = '';
    e.target.style.height = '';
    sendChatMessage(text);
  }
});

// ── Chat voice input ──

function initChatVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    document.getElementById('chat-mic').style.display = 'none';
    return;
  }

  chatRecognition = new SpeechRecognition();
  chatRecognition.continuous = true;
  chatRecognition.interimResults = true;
  chatRecognition.lang = 'en-US';

  chatRecognition.onresult = (e) => {
    let final = '';
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        final += e.results[i][0].transcript;
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    const input = document.getElementById('chat-input');
    const sep = chatTextBeforeRecording ? chatTextBeforeRecording + ' ' : '';
    const cleaned = typeof punctuate === 'function' ? punctuate(final) : final;
    input.value = sep + cleaned + (interim ? ' ' + interim : '');
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  };

  chatRecognition.onend = () => {
    if (chatIsRecording) {
      // Preserve accumulated text before restarting
      chatTextBeforeRecording = document.getElementById('chat-input').value.trim();
      chatRecognition.start();
      return;
    }
    chatTextBeforeRecording = '';
    document.getElementById('chat-mic').classList.remove('recording');
  };

  chatRecognition.onerror = (e) => {
    if (e.error === 'no-speech') return;
    console.error('Chat speech error:', e.error);
    stopChatRecording();
  };
}

function startChatRecording() {
  if (!chatRecognition) return;
  chatIsRecording = true;
  chatTextBeforeRecording = document.getElementById('chat-input').value.trim();
  chatRecognition.start();
  document.getElementById('chat-mic').classList.add('recording');
}

function stopChatRecording(autoSend = false) {
  if (!chatRecognition) return;
  chatIsRecording = false;
  chatRecognition.stop();
  document.getElementById('chat-mic').classList.remove('recording');
  if (autoSend) {
    setTimeout(() => {
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (text) {
        input.value = '';
        sendChatMessage(text);
      }
    }, 400);
  }
}

function toggleChatRecording() {
  if (chatIsRecording) {
    stopChatRecording(false); // let user review and send manually
  } else {
    startChatRecording();
  }
}

document.getElementById('chat-mic').addEventListener('click', toggleChatRecording);
initChatVoice();

// Suggestion buttons (initial)
document.querySelectorAll('.chat-suggestion').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('chat-input').value = '';
    sendChatMessage(btn.textContent);
  });
});

// Copy individual message + reference clicks (delegated)
document.getElementById('chat-messages').addEventListener('click', (e) => {
  const ref = e.target.closest('.chat-ref');
  if (ref) {
    e.preventDefault();
    const refType = ref.dataset.refType;
    const refFile = ref.dataset.refFile;
    if (refType === 'comment') {
      navigateToComment(refFile, parseInt(ref.dataset.refIdx));
    } else {
      navigateToImage(refFile);
    }
    return;
  }
  // Smart card expand/collapse
  const toggle = e.target.closest('.chat-fileset-overflow');
  if (toggle) {
    const card = toggle.closest('.chat-fileset');
    const isExpanded = card.classList.toggle('expanded');
    toggle.textContent = isExpanded ? 'Show less' : `+${card.querySelectorAll('.hidden-thumb').length}`;
    return;
  }
  // Smart card thumbnail click — navigate to file
  const thumb = e.target.closest('.chat-fileset-thumb');
  if (thumb && thumb.dataset.file) {
    navigateToImage(thumb.dataset.file);
    return;
  }
  // Smart card download
  const dlBtn = e.target.closest('.chat-fileset-download');
  if (dlBtn) {
    const msgIdx = parseInt(dlBtn.dataset.filesetIdx);
    const msg = chatHistory[msgIdx];
    if (msg && msg.fileset) downloadFileset(msg.fileset.files, msg.fileset.description, dlBtn);
    return;
  }
  const btn = e.target.closest('.chat-copy-btn');
  if (!btn) return;
  const idx = parseInt(btn.dataset.copyIdx);
  const msg = chatHistory[idx];
  if (!msg) return;
  navigator.clipboard.writeText(msg.content).then(() => {
    btn.classList.add('copied');
    btn.innerHTML = btn.innerHTML.replace('Copy', 'Copied!');
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = btn.innerHTML.replace('Copied!', 'Copy');
    }, 1500);
  });
});

// Copy entire conversation
document.getElementById('chat-copy-all').addEventListener('click', () => {
  if (chatHistory.length === 0) return;
  const text = chatHistory.map(m =>
    m.role === 'user' ? `**You:** ${m.content}` : `**Claude:** ${m.content}`
  ).join('\n\n---\n\n');
  navigator.clipboard.writeText(text).then(() => {
    const tip = document.getElementById('chat-copy-all-tooltip');
    tip.classList.add('show');
    setTimeout(() => tip.classList.remove('show'), 1500);
  });
});

// No-op for backward compat with enterGallery/exitGallery calls
function updateChatFabVisibility() {}
