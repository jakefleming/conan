// ── Copy Functions ──
// Extracted from index.html: copy image, copy annotated image with legend, copy chat

async function copyImageToClipboard(blob, btn, label) {
  const originalHtml = btn.innerHTML;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]);
    btn.style.opacity = '0.5';
  } catch (e) {
    console.error('Copy failed:', e);
    btn.style.opacity = '0.5';
  }
  setTimeout(() => { btn.innerHTML = originalHtml; btn.style.opacity = ''; btn.disabled = false; }, 1500);
}

// Word-wrap text onto canvas, returns array of lines
function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ── Copy Dropdown Toggle ──
document.getElementById('btn-copy-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('copy-dropdown').classList.toggle('open');
});
document.addEventListener('click', (e) => {
  const dd = document.getElementById('copy-dropdown');
  if (dd && !dd.contains(e.target)) {
    dd.classList.remove('open');
  }
});

// ── Copy (plain image) ──
document.getElementById('btn-copy-image').addEventListener('click', async () => {
  document.getElementById('copy-dropdown').classList.remove('open');
  const file = onlyFiles()[currentIndex];
  if (!file) return;
  const btn = document.getElementById('btn-copy-menu');
  const originalHtml = btn.innerHTML;
  btn.style.opacity = '0.5';
  btn.disabled = true;

  try {
    const img = document.getElementById('zoom-img');
    if (!img || !img.naturalWidth) throw new Error('Image not ready');
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(), 'image/png'));
    await copyImageToClipboard(blob, btn, 'Copy');
  } catch (e) {
    console.error('Copy image failed:', e);
    btn.style.opacity = '0.5';
    setTimeout(() => { btn.innerHTML = originalHtml; btn.style.opacity = ''; btn.disabled = false; }, 1500);
  }
});

// ── Copy+ (annotated image with comment legend) ──
document.getElementById('btn-copy-context').addEventListener('click', async () => {
  document.getElementById('copy-dropdown').classList.remove('open');
  const file = onlyFiles()[currentIndex];
  if (!file) return;
  const btn = document.getElementById('btn-copy-menu');
  const originalHtml = btn.innerHTML;
  btn.style.opacity = '0.5';
  btn.disabled = true;

  try {
    const img = document.getElementById('zoom-img');
    if (!img || !img.naturalWidth) throw new Error('Image not ready');

    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    const comments = file.comments || [];

    // --- Right rail layout (image left, annotations right) ---
    const railWidth = Math.round(natW * 0.38);
    const railPad = Math.round(railWidth * 0.06);
    const fontSize = Math.max(13, Math.round(railWidth / 22));
    const lineHeight = Math.round(fontSize * 1.55);
    const maxTextW = railWidth - railPad * 2;
    const titleFontSize = Math.round(fontSize * 1.15);
    const numFontSize = Math.round(fontSize * 0.85);

    // Pre-compute wrapped lines
    const measureCanvas = document.createElement('canvas');
    const measureCtx = measureCanvas.getContext('2d');
    measureCtx.font = `${fontSize}px -apple-system, system-ui, sans-serif`;

    const commentBlocks = comments.map((c, i) => {
      const lines = wrapText(measureCtx, c.text, maxTextW - railPad);
      return { index: i, comment: c, lines };
    });

    // Calculate rail height — at minimum match image height
    const commentGap = Math.round(lineHeight * 0.8);
    const headerH = Math.round(titleFontSize * 3);
    const contentH = commentBlocks.reduce((sum, b) => sum + (numFontSize + 4) + b.lines.length * lineHeight + commentGap, 0);
    const railH = Math.max(natH, headerH + contentH + railPad * 2);

    // --- Draw everything ---
    const canvas = document.createElement('canvas');
    const totalW = comments.length > 0 ? natW + railWidth : natW;
    const totalH = comments.length > 0 ? Math.max(natH, railH) : natH;
    canvas.width = totalW;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');

    // Background behind everything (theme-aware)
    const isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
    ctx.fillStyle = isDarkMode ? '#141414' : '#f5f4f0';
    ctx.fillRect(0, 0, totalW, totalH);

    // Draw image on left
    ctx.drawImage(img, 0, 0, natW, natH);

    // Draw region rectangles on image
    ctx.strokeStyle = cssVar('--region-stroke');
    ctx.lineWidth = Math.max(4, Math.round(natW / 350));
    comments.filter(c => c.region).forEach(c => {
      const r = c.region;
      const x = (r.x / 100) * natW;
      const y = (r.y / 100) * natH;
      const w = (r.w / 100) * natW;
      const h = (r.h / 100) * natH;
      ctx.strokeRect(x, y, w, h);
      const label = `#${comments.indexOf(c) + 1}`;
      const labelFontSize = Math.max(14, Math.round(natW / 130));
      ctx.font = `bold ${labelFontSize}px 'Instrument Sans', -apple-system, sans-serif`;
      const metrics = ctx.measureText(label);
      const pad = 4;
      ctx.fillStyle = cssVar('--region-label-bg');
      ctx.fillRect(x, y - labelFontSize - pad * 2, metrics.width + pad * 2, labelFontSize + pad * 2);
      ctx.fillStyle = cssVar('--region-label-text');
      ctx.fillText(label, x + pad, y - pad);
    });

    // Draw right rail
    if (comments.length > 0) {
      const rx = natW;

      // Rail background
      ctx.fillStyle = isDarkMode ? '#1a1a1a' : '#ffffff';
      ctx.fillRect(rx, 0, railWidth, totalH);

      // Subtle left border
      ctx.strokeStyle = isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rx, 0);
      ctx.lineTo(rx, totalH);
      ctx.stroke();

      // Title
      ctx.fillStyle = isDarkMode ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
      ctx.font = `600 ${titleFontSize}px 'Instrument Sans', -apple-system, system-ui, sans-serif`;
      ctx.fillText(file.name, rx + railPad, railPad + titleFontSize);

      // Subtitle
      ctx.fillStyle = isDarkMode ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)';
      ctx.font = `${numFontSize}px 'Instrument Sans', -apple-system, system-ui, sans-serif`;
      ctx.fillText(`${comments.length} annotation${comments.length !== 1 ? 's' : ''}`, rx + railPad, railPad + titleFontSize + numFontSize + 6);

      // Separator
      const sepY = headerH - 4;
      ctx.strokeStyle = isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
      ctx.beginPath();
      ctx.moveTo(rx + railPad, sepY);
      ctx.lineTo(rx + railWidth - railPad, sepY);
      ctx.stroke();

      // Comments
      let curY = headerH + railPad;

      commentBlocks.forEach((block) => {
        // Number badge
        const badge = `#${block.index + 1}`;
        const authorLabel = block.comment.author === 'claude' ? 'CLAUDE' : 'USER';
        ctx.font = `bold ${numFontSize}px 'Instrument Sans', -apple-system, system-ui, sans-serif`;
        ctx.fillStyle = block.comment.author === 'claude' ? cssVar('--comment-claude-color') : cssVar('--comment-user-color');
        ctx.fillText(`${authorLabel}  ${badge}`, rx + railPad, curY + numFontSize);
        curY += numFontSize + 6;

        // Comment text
        ctx.font = `${fontSize}px 'Instrument Sans', -apple-system, system-ui, sans-serif`;
        ctx.fillStyle = isDarkMode ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)';
        block.lines.forEach((line) => {
          ctx.fillText(line, rx + railPad, curY + fontSize);
          curY += lineHeight;
        });

        curY += commentGap;
      });
    }

    // Export and copy
    const blob = await new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/png'));
    await copyImageToClipboard(blob, btn, 'Copy+');
  } catch (e) {
    console.error('Copy+ failed:', e);
    btn.style.opacity = '0.5';
    setTimeout(() => { btn.innerHTML = originalHtml; btn.style.opacity = ''; btn.disabled = false; }, 1500);
  }
});

// ── Copy chat (file comments as markdown transcript) ──
document.getElementById('btn-copy-chat').addEventListener('click', async () => {
  const file = onlyFiles()[currentIndex];
  if (!file) return;
  const comments = file.comments || [];
  if (comments.length === 0) {
    document.getElementById('copy-dropdown').classList.remove('open');
    showRefError('No comments to copy');
    return;
  }
  const lines = [`# ${file.name}\n`];
  comments.forEach((c, i) => {
    const author = c.author === 'claude' ? 'Claude' : 'User';
    const date = c.ts ? new Date(c.ts).toLocaleDateString() : '';
    lines.push(`**${author}** ${date ? '(' + date + ')' : ''}`);
    lines.push(c.text);
    lines.push('');
  });
  const text = lines.join('\n').trim();
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById('btn-copy-chat');
    btn.innerHTML = '<i class="ph ph-check" style="font-size:14px;color:var(--green)"></i> Copied!';
    btn.style.color = 'var(--green)';
    setTimeout(() => {
      document.getElementById('copy-dropdown').classList.remove('open');
      btn.innerHTML = '<i class="ph ph-chat-text" style="font-size:14px"></i> Copy chat';
      btn.style.color = '';
    }, 1000);
  } catch (e) {
    console.error('Copy chat failed:', e);
    document.getElementById('copy-dropdown').classList.remove('open');
  }
});
