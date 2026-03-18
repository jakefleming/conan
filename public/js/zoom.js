// ── Zoom, Pan & Viewport Interaction ──

function getVisualDims() {
  const isR = rotation % 180 !== 0;
  return {
    visW: isR ? zoomNatH : zoomNatW,
    visH: isR ? zoomNatW : zoomNatH,
    rotOffX: isR ? (zoomNatW - zoomNatH) / 2 : 0,
    rotOffY: isR ? (zoomNatH - zoomNatW) / 2 : 0,
  };
}

function initZoom() {
  const img = document.getElementById('zoom-img');
  const container = document.getElementById('zoom-container');
  if (!img || !container) return;

  zoomScale = 1; zoomX = 0; zoomY = 0; rotation = 0;
  stagedRegion = null; drawingRegion = null; hoveredCommentRegion = null;

  img.addEventListener('load', () => {
    zoomNatW = img.naturalWidth;
    zoomNatH = img.naturalHeight;
    fitImage();
  });
  if (img.complete && img.naturalWidth) {
    zoomNatW = img.naturalWidth;
    zoomNatH = img.naturalHeight;
    fitImage();
  }

  container.addEventListener('wheel', onZoomWheel, { passive: false });
  container.addEventListener('mousedown', onPanStart);
  container.addEventListener('dblclick', onZoomDblClick);
}

function fitImage() {
  const container = document.getElementById('zoom-container');
  const img = document.getElementById('zoom-img');
  if (!container || !img || !zoomNatW) return;

  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const { visW, visH, rotOffX, rotOffY } = getVisualDims();
  zoomFitScale = Math.min(cw / visW, ch / visH);
  zoomScale = zoomFitScale;
  zoomX = (cw - visW * zoomScale) / 2 - rotOffX * zoomScale;
  zoomY = (ch - visH * zoomScale) / 2 - rotOffY * zoomScale;
  applyZoom();
  renderRegionOverlay();
}

function applyZoom() {
  const img = document.getElementById('zoom-img');
  if (!img) return;
  const cx = zoomNatW / 2;
  const cy = zoomNatH / 2;
  const t = `translate(${zoomX}px, ${zoomY}px) scale(${zoomScale}) translate(${cx}px, ${cy}px) rotate(${rotation}deg) translate(${-cx}px, ${-cy}px)`;
  img.style.transform = t;
  img.style.width = zoomNatW + 'px';
  img.style.height = zoomNatH + 'px';
  const svg = document.getElementById('region-overlay');
  if (svg) {
    svg.style.transform = t;
    svg.setAttribute('width', zoomNatW);
    svg.setAttribute('height', zoomNatH);
  }
}

function clampPan() {
  const container = document.getElementById('zoom-container');
  if (!container) return;
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const { visW, visH, rotOffX, rotOffY } = getVisualDims();
  const imgW = visW * zoomScale;
  const imgH = visH * zoomScale;

  // Work in terms of the effective visual position
  let effX = zoomX + rotOffX * zoomScale;
  let effY = zoomY + rotOffY * zoomScale;

  if (imgW <= cw) {
    effX = (cw - imgW) / 2;
  } else {
    effX = Math.min(0, Math.max(cw - imgW, effX));
  }
  if (imgH <= ch) {
    effY = (ch - imgH) / 2;
  } else {
    effY = Math.min(0, Math.max(ch - imgH, effY));
  }

  zoomX = effX - rotOffX * zoomScale;
  zoomY = effY - rotOffY * zoomScale;
}

function onZoomWheel(e) {
  e.preventDefault();
  const container = document.getElementById('zoom-container');
  if (!container || !zoomNatW) return;

  if (e.ctrlKey) {
    // Pinch-to-zoom (trackpad pinch fires wheel with ctrlKey)
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const oldScale = zoomScale;
    // Pinch deltaY is usually smaller, so use a gentler factor
    const factor = Math.exp(-e.deltaY * 0.01);
    let newScale = zoomScale * factor;

    const minScale = zoomFitScale * 0.95;
    const maxScale = Math.max(zoomFitScale * 8, 4);
    newScale = Math.max(minScale, Math.min(maxScale, newScale));

    zoomX = mx - (mx - zoomX) * (newScale / oldScale);
    zoomY = my - (my - zoomY) * (newScale / oldScale);
    zoomScale = newScale;
  } else {
    // Two-finger scroll → pan
    zoomX -= e.deltaX;
    zoomY -= e.deltaY;
  }

  clampPan();
  applyZoom();
}

function onZoomDblClick(e) {
  const container = document.getElementById('zoom-container');
  if (!container || !zoomNatW) return;

  const isZoomed = zoomScale > zoomFitScale * 1.02;
  if (isZoomed) {
    fitImage();
  } else {
    // Zoom to 1:1 centered on click point
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const oldScale = zoomScale;
    const newScale = Math.max(1, zoomFitScale * 3);
    zoomX = mx - (mx - zoomX) * (newScale / oldScale);
    zoomY = my - (my - zoomY) * (newScale / oldScale);
    zoomScale = newScale;
    clampPan();
    applyZoom();
  }
}

function onPanStart(e) {
  // Hold Cmd/Ctrl (or Alt) to draw through existing regions
  const forceDrawMode = e.metaKey || e.ctrlKey || e.altKey;

  // Check if click is on an SVG region element
  const target = e.target;
  if (!forceDrawMode && target.dataset && target.dataset.regionIdx !== undefined) {
    const idx = parseInt(target.dataset.regionIdx, 10);
    e.preventDefault();
    editingRegionIndex = idx;

    // Determine drag type from click position relative to region edges
    const comment = (onlyFiles()[currentIndex].comments || [])[idx];
    if (comment && comment.region) {
      const clickPt = viewportToImgPct(e.clientX, e.clientY);
      const r = comment.region;
      const edgePct = Math.max(1.5, Math.min(4, Math.min(r.w, r.h) * 0.2)); // % threshold for edges
      const nearL = clickPt.x - r.x < edgePct;
      const nearR = (r.x + r.w) - clickPt.x < edgePct;
      const nearT = clickPt.y - r.y < edgePct;
      const nearB = (r.y + r.h) - clickPt.y < edgePct;

      let dragType = 'move';
      if (nearT && nearL) dragType = 'nw';
      else if (nearT && nearR) dragType = 'ne';
      else if (nearB && nearL) dragType = 'sw';
      else if (nearB && nearR) dragType = 'se';
      else if (nearT) dragType = 'n';
      else if (nearB) dragType = 's';
      else if (nearL) dragType = 'w';
      else if (nearR) dragType = 'e';

      onEditStart(e, idx, dragType);
    } else {
      onEditStart(e, idx, 'move');
    }
    return;
  }

  // Click was outside all regions — deselect and draw
  if (editingRegionIndex !== null || selectedRegionIndex !== null) {
    editingRegionIndex = null;
    selectedRegionIndex = null;
    renderRegionOverlay();
  }
  onDrawStart(e);
}
