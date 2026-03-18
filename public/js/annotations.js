// ── Region Annotations: Drawing, Editing, Overlay & Description ──

function onEditStart(e, idx, type) {
  editDragType = type;
  editingRegionIndex = idx;
  const comments = onlyFiles()[currentIndex].comments || [];
  editStartRegion = { ...comments[idx].region };
  editStartMouse = viewportToImgPct(e.clientX, e.clientY);

  const onMove = (ev) => {
    const cur = viewportToImgPct(ev.clientX, ev.clientY);
    const dx = cur.x - editStartMouse.x;
    const dy = cur.y - editStartMouse.y;
    const r = editStartRegion;
    const comment = onlyFiles()[currentIndex].comments[idx];

    if (editDragType === 'move') {
      comment.region = {
        x: Math.max(0, Math.min(100 - r.w, r.x + dx)),
        y: Math.max(0, Math.min(100 - r.h, r.y + dy)),
        w: r.w,
        h: r.h,
      };
    } else {
      let nx = r.x, ny = r.y, nw = r.w, nh = r.h;
      // Left edge moves
      if (editDragType === 'nw' || editDragType === 'sw' || editDragType === 'w') {
        nx = Math.max(0, Math.min(r.x + r.w - 2, r.x + dx));
        nw = r.w - (nx - r.x);
      }
      // Right edge moves
      if (editDragType === 'ne' || editDragType === 'se' || editDragType === 'e') {
        nw = Math.max(2, r.w + dx);
      }
      // Top edge moves
      if (editDragType === 'nw' || editDragType === 'ne' || editDragType === 'n') {
        ny = Math.max(0, Math.min(r.y + r.h - 2, r.y + dy));
        nh = r.h - (ny - r.y);
      }
      // Bottom edge moves
      if (editDragType === 'sw' || editDragType === 'se' || editDragType === 's') {
        nh = Math.max(2, r.h + dy);
      }
      comment.region = { x: nx, y: ny, w: Math.min(100 - nx, nw), h: Math.min(100 - ny, nh) };
    }
    renderRegionOverlay();
  };

  let didDrag = false;
  const origOnMove = onMove;
  const trackingOnMove = (ev) => {
    const cur = viewportToImgPct(ev.clientX, ev.clientY);
    const dx = Math.abs(cur.x - editStartMouse.x);
    const dy = Math.abs(cur.y - editStartMouse.y);
    if (dx > 0.5 || dy > 0.5) didDrag = true;
    origOnMove(ev);
  };

  const onUp = async () => {
    document.removeEventListener('mousemove', trackingOnMove);
    document.removeEventListener('mouseup', onUp);
    editDragType = null;
    const savedStart = editStartMouse;
    editStartMouse = null;
    editStartRegion = null;

    if (!didDrag) {
      // Click without drag → select/deselect this region
      selectedRegionIndex = (selectedRegionIndex === idx) ? null : idx;
      renderRegionOverlay();
      return;
    }

    selectedRegionIndex = null;
    // Save to server
    const file = onlyFiles()[currentIndex];
    const comment = file.comments[idx];
    try {
      await api(`/api/files/${encodeURIComponent(file.path)}/comments/${idx}/region`, {
        method: 'PUT',
        body: { region: comment.region },
      });
    } catch (err) {
      console.error('Failed to save region edit:', err);
    }
  };

  document.addEventListener('mousemove', trackingOnMove);
  document.addEventListener('mouseup', onUp);
  renderRegionOverlay();
}

// ── Region Drawing ──
function viewportToImgPct(clientX, clientY) {
  const container = document.getElementById('zoom-container');
  const rect = container.getBoundingClientRect();
  const vpX = clientX - rect.left;
  const vpY = clientY - rect.top;
  // Undo translate and scale
  let rawX = (vpX - zoomX) / zoomScale;
  let rawY = (vpY - zoomY) / zoomScale;
  // Undo rotation around image center
  const cx = zoomNatW / 2;
  const cy = zoomNatH / 2;
  let rx = rawX - cx;
  let ry = rawY - cy;
  if (rotation === 90)  { [rx, ry] = [ry, -rx]; }
  else if (rotation === 180) { [rx, ry] = [-rx, -ry]; }
  else if (rotation === 270) { [rx, ry] = [-ry, rx]; }
  const imgX = rx + cx;
  const imgY = ry + cy;
  return {
    x: Math.max(0, Math.min(100, (imgX / zoomNatW) * 100)),
    y: Math.max(0, Math.min(100, (imgY / zoomNatH) * 100)),
  };
}

function onDrawStart(e) {
  e.preventDefault();
  const altHeldOnStart = e.altKey;
  const start = viewportToImgPct(e.clientX, e.clientY);
  drawStartImgX = start.x;
  drawStartImgY = start.y;
  drawingRegion = { x: start.x, y: start.y, w: 0, h: 0 };

  const onMove = (ev) => {
    const cur = viewportToImgPct(ev.clientX, ev.clientY);
    drawingRegion = {
      x: Math.min(drawStartImgX, cur.x),
      y: Math.min(drawStartImgY, cur.y),
      w: Math.abs(cur.x - drawStartImgX),
      h: Math.abs(cur.y - drawStartImgY),
    };
    renderRegionOverlay();
  };

  const onUp = (ev) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const altHeld = altHeldOnStart || ev.altKey;

    // Only stage if region is big enough (>0.5% in both dims — roughly a click vs a drag)
    if (drawingRegion && drawingRegion.w > 0.5 && drawingRegion.h > 0.5) {
      stagedRegion = { ...drawingRegion };
      drawingRegion = null;
      renderRegionOverlay();
      updateStagedRegionUI();
      if (altHeld) {
        // Alt held → immediately ask Claude to describe this region
        describeRegionWithClaude();
      } else {
        document.getElementById('comment-input').focus();
      }
    } else {
      drawingRegion = null;
      renderRegionOverlay();
    }
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function renderRegionOverlay() {
  const svg = document.getElementById('region-overlay');
  if (!svg || !zoomNatW) return;

  let rects = '';
  const handleSize = Math.max(8, Math.round(zoomNatW / 200));

  // 1. Drawing region (active drag)
  if (drawingRegion) {
    const r = drawingRegion;
    const x = (r.x / 100) * zoomNatW;
    const y = (r.y / 100) * zoomNatH;
    const w = (r.w / 100) * zoomNatW;
    const h = (r.h / 100) * zoomNatH;
    rects += `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="region-rect-drawing"/>`;
  }

  // 2. Staged region (ready to attach to comment)
  if (stagedRegion) {
    const r = stagedRegion;
    const x = (r.x / 100) * zoomNatW;
    const y = (r.y / 100) * zoomNatH;
    const w = (r.w / 100) * zoomNatW;
    const h = (r.h / 100) * zoomNatH;
    rects += `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="region-rect-staged"/>`;
  }

  // 3. Persistent comment regions
  if (showAnnotations && onlyFiles()[currentIndex]) {
    const comments = onlyFiles()[currentIndex].comments || [];
    comments.forEach((c, i) => {
      if (!c.region) return;
      const r = c.region;
      const x = (r.x / 100) * zoomNatW;
      const y = (r.y / 100) * zoomNatH;
      const w = (r.w / 100) * zoomNatW;
      const h = (r.h / 100) * zoomNatH;

      // Determine class based on focus/selection state
      let cls = 'region-rect-persistent';
      const isSelected = selectedRegionIndex === i;
      if (isSelected) cls = 'region-rect-selected';
      else if (focusedCommentIndex === i) cls = 'region-rect-focused';
      else if (focusedCommentIndex !== null) cls = 'region-rect-dimmed';

      // Body rect — pointer-events for hover + drag-to-move/resize
      rects += `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="${cls}" data-region-idx="${i}" style="pointer-events:all;cursor:move"/>`;

      // Label
      const fontSize = Math.max(12, Math.round(zoomNatW / 150));
      const labelText = isSelected ? `#${i + 1} ⌫` : `#${i + 1}`;
      const labelW = fontSize * labelText.length * 0.65 + 8;
      const labelH = fontSize + 6;
      const labelFill = isSelected ? cssVar('--region-label-selected-bg') : cssVar('--region-label-bg');
      const labelOpacity = cls === 'region-rect-dimmed' ? 0.15 : (cls === 'region-rect-focused' || isSelected ? 1 : 0.7);
      rects += `<rect x="${x}" y="${y - labelH}" width="${labelW}" height="${labelH}" fill="${labelFill}" rx="2" style="pointer-events:none;opacity:${labelOpacity}"/>`;
      const labelTextColor = isSelected ? cssVar('--region-label-selected-text') : cssVar('--region-label-text');
      rects += `<text x="${x + 4}" y="${y - 4}" fill="${labelTextColor}" font-size="${fontSize}" font-weight="bold" font-family="'Instrument Sans',-apple-system,sans-serif" style="pointer-events:none;opacity:${labelOpacity}">${labelText}</text>`;
    });
  }

  svg.innerHTML = rects;

  // Attach hover listeners on persistent rects for focus/dim + dynamic cursor
  if (showAnnotations) {
    svg.querySelectorAll('[data-region-idx]').forEach(el => {
      el.addEventListener('mouseenter', () => {
        if (editDragType) return; // don't change focus while dragging/resizing
        const idx = parseInt(el.dataset.regionIdx, 10);
        if (focusedCommentIndex !== idx) {
          focusedCommentIndex = idx;
          highlightSidebarComment(idx);
          renderRegionOverlay();
        }
      });
      el.addEventListener('mouseleave', () => {
        if (editDragType) return; // don't change focus while dragging/resizing
        if (focusedCommentIndex !== null) {
          focusedCommentIndex = null;
          highlightSidebarComment(null);
          renderRegionOverlay();
        }
      });
      // Dynamic cursor based on position within rect
      el.addEventListener('mousemove', (ev) => {
        const idx = parseInt(el.dataset.regionIdx, 10);
        const comment = (onlyFiles()[currentIndex].comments || [])[idx];
        if (!comment || !comment.region) return;
        const pt = viewportToImgPct(ev.clientX, ev.clientY);
        const r = comment.region;
        const edgePct = Math.max(1.5, Math.min(4, Math.min(r.w, r.h) * 0.2));
        const nearL = pt.x - r.x < edgePct;
        const nearR = (r.x + r.w) - pt.x < edgePct;
        const nearT = pt.y - r.y < edgePct;
        const nearB = (r.y + r.h) - pt.y < edgePct;
        let cursor = 'move';
        if ((nearT && nearL) || (nearB && nearR)) cursor = 'nwse-resize';
        else if ((nearT && nearR) || (nearB && nearL)) cursor = 'nesw-resize';
        else if (nearT || nearB) cursor = 'ns-resize';
        else if (nearL || nearR) cursor = 'ew-resize';
        el.style.cursor = cursor;
      });
      // Right-click "Send to Chat" on region rects
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const idx = parseInt(el.dataset.regionIdx, 10);
        const file = onlyFiles()[currentIndex];
        if (!file) return;
        const comment = (file.comments || [])[idx];
        if (!comment || !comment.region) return;
        showContextMenu(ev.clientX, ev.clientY, [
          { label: 'Send crop to Chat', icon: 'sparkle', action: () => {
            addProjectAttachment(file.path, comment.region, `#${idx+1} crop`);
            if (!chatOpen) toggleChat();
          }},
          { label: 'Send full image to Chat', icon: 'image', action: () => {
            addProjectAttachment(file.path, null, file.name);
            if (!chatOpen) toggleChat();
          }},
        ]);
      });
    });
  }
}

// Highlight a comment in the sidebar by index
function highlightSidebarComment(idx) {
  document.querySelectorAll('#comments-list .comment').forEach((el, i) => {
    if (idx === null) {
      el.style.opacity = '';
      el.style.outline = '';
    } else if (i === idx) {
      el.style.opacity = '1';
      el.style.outline = `1px solid ${cssVar('--region-stroke')}`;
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      el.style.opacity = '0.3';
      el.style.outline = '';
    }
  });
}

function updateStagedRegionUI() {
  let el = document.getElementById('staged-region-bar');
  const commentInput = document.getElementById('comment-input');
  if (stagedRegion) {
    if (!el) {
      el = document.createElement('div');
      el.id = 'staged-region-bar';
      el.className = 'region-clear';
      el.innerHTML = '<span>Region selected</span><button class="btn-claude-region" id="btn-claude-region" title="Ask Claude to describe this region">Ask Claude</button><span class="region-clear-x">&times;</span>';
      el.querySelector('.region-clear-x').addEventListener('click', clearStagedRegion);
      el.querySelector('#btn-claude-region').addEventListener('click', describeRegionWithClaude);
      const inputArea = document.querySelector('.sidebar-input');
      inputArea.insertBefore(el, inputArea.firstChild);
    }
    commentInput.placeholder = 'Enter → Ask Claude · or type your own comment';
  } else {
    if (el) el.remove();
    commentInput.placeholder = 'Add your context...';
  }
}

function updateDescribeStatus() {
  const bar = document.getElementById('describe-queue-bar');
  if (describePendingCount > 0) {
    if (!bar) {
      const el = document.createElement('div');
      el.id = 'describe-queue-bar';
      el.className = 'region-clear';
      el.style.background = 'rgba(234,179,8,0.12)';
      el.style.borderColor = 'var(--gold)';
      el.style.color = 'var(--gold)';
      const inputArea = document.querySelector('.sidebar-input');
      inputArea.insertBefore(el, inputArea.firstChild);
    }
    const el = document.getElementById('describe-queue-bar');
    el.textContent = describePendingCount === 1
      ? 'Claude is thinking...'
      : `Claude is thinking... (${describePendingCount} regions queued)`;
  } else if (bar) {
    bar.remove();
  }
}

async function processDescribeQueue() {
  if (describeProcessing) return;
  describeProcessing = true;

  while (describeQueue.length > 0) {
    const { filePath, region } = describeQueue.shift();
    try {
      const res = await api(`/api/files/${encodeURIComponent(filePath)}/describe-region`, {
        method: 'POST',
        body: { region },
      });
      if (res.error) {
        console.error('Describe region error:', res.error);
        alert('Claude annotation failed: ' + res.error);
      }
    } catch (e) {
      console.error('Describe region failed:', e.message);
      alert('Claude annotation failed: ' + e.message);
    }
    describePendingCount--;
    updateDescribeStatus();
    // Refresh after each one so the user sees results appearing
    await reloadCurrentDir();
    refreshSidebar();
  }

  describeProcessing = false;
}

function describeRegionWithClaude() {
  if (!stagedRegion) return;
  if (!hasApiKey) {
    document.getElementById('btn-settings').click();
    return;
  }
  const file = onlyFiles()[currentIndex];
  if (!file) return;

  // Capture region and clear immediately so user can draw the next one
  const region = { ...stagedRegion };
  stagedRegion = null;
  updateStagedRegionUI();
  renderRegionOverlay();

  // Enqueue
  describeQueue.push({ filePath: file.path, region });
  describePendingCount++;
  updateDescribeStatus();
  processDescribeQueue();
}

function clearStagedRegion() {
  stagedRegion = null;
  renderRegionOverlay();
  updateStagedRegionUI();
}

function rotateCanvas(dir) {
  rotation = (rotation + dir + 360) % 360;
  fitImage();
  renderRegionOverlay();
}
