// docx.js — Renders Word documents (.docx) as formatted HTML

async function renderDocx(filePath, container) {
  container.innerHTML = '<div style="padding:24px;color:var(--text-secondary)">Loading document...</div>';

  try {
    const res = await fetch(`/api/files/${encodeURIComponent(filePath)}/docx`);
    if (!res.ok) {
      const err = await res.json();
      container.innerHTML = `<div style="padding:24px;color:var(--red)">${escapeHtml(err.error || 'Failed to load document')}</div>`;
      return;
    }

    const data = await res.json();
    if (!data.elements || data.elements.length === 0) {
      container.innerHTML = '<div style="padding:24px;color:var(--text-secondary)">No content found in document.</div>';
      return;
    }

    container.innerHTML = '';

    const docWrap = document.createElement('div');
    docWrap.className = 'docx-content';

    for (const el of data.elements) {
      if (el.type === 'heading') {
        const h = document.createElement('h' + Math.min(el.level || 1, 6));
        h.className = 'docx-heading';
        renderInlineContent(h, el.runs || [{ text: el.text }]);
        docWrap.appendChild(h);
      } else if (el.type === 'paragraph') {
        const p = document.createElement('p');
        p.className = 'docx-paragraph';
        if (el.indent) p.style.marginLeft = el.indent + 'px';
        if (el.align) p.style.textAlign = el.align;
        renderInlineContent(p, el.runs || [{ text: el.text }]);
        if (p.textContent || p.querySelector('*')) {
          docWrap.appendChild(p);
        } else {
          // Empty paragraph as spacing
          const br = document.createElement('div');
          br.className = 'docx-spacer';
          docWrap.appendChild(br);
        }
      } else if (el.type === 'list-item') {
        // Group consecutive list items
        let list = docWrap.lastElementChild;
        const tag = el.numType === 'ordered' ? 'ol' : 'ul';
        if (!list || list.tagName.toLowerCase() !== tag || list.dataset.listId !== String(el.listId || 0)) {
          list = document.createElement(tag);
          list.className = 'docx-list';
          list.dataset.listId = String(el.listId || 0);
          docWrap.appendChild(list);
        }
        const li = document.createElement('li');
        renderInlineContent(li, el.runs || [{ text: el.text }]);
        list.appendChild(li);
      } else if (el.type === 'table') {
        const tableWrap = document.createElement('div');
        tableWrap.className = 'docx-table-wrap';
        const table = document.createElement('table');
        table.className = 'docx-table';
        for (const row of (el.rows || [])) {
          const tr = document.createElement('tr');
          for (const cell of (row.cells || [])) {
            const td = document.createElement('td');
            if (cell.bold) td.style.fontWeight = '600';
            td.textContent = cell.text || '';
            tr.appendChild(td);
          }
          table.appendChild(tr);
        }
        tableWrap.appendChild(table);
        docWrap.appendChild(tableWrap);
      }
    }

    container.appendChild(docWrap);
  } catch (e) {
    container.innerHTML = `<div style="padding:24px;color:var(--red)">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function renderInlineContent(parent, runs) {
  for (const run of runs) {
    if (!run.text) continue;
    let node;
    if (run.bold || run.italic || run.underline || run.strike) {
      node = document.createElement('span');
      if (run.bold) node.style.fontWeight = '700';
      if (run.italic) node.style.fontStyle = 'italic';
      if (run.underline) node.style.textDecoration = 'underline';
      if (run.strike) node.style.textDecoration = 'line-through';
      node.textContent = run.text;
    } else {
      node = document.createTextNode(run.text);
    }
    parent.appendChild(node);
  }
}
