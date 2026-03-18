// spreadsheet.js — Renders spreadsheet files (xlsx, csv, tsv, etc.) as HTML tables

async function renderSpreadsheet(filePath, container) {
  container.innerHTML = '<div style="padding:24px;color:var(--text-secondary)">Loading spreadsheet...</div>';

  try {
    const res = await fetch(`/api/files/${encodeURIComponent(filePath)}/spreadsheet`);
    if (!res.ok) {
      const err = await res.json();
      container.innerHTML = `<div style="padding:24px;color:var(--red)">${escapeHtml(err.error || 'Failed to load spreadsheet')}</div>`;
      return;
    }

    const data = await res.json();
    if (!data.sheets || data.sheets.length === 0) {
      container.innerHTML = '<div style="padding:24px;color:var(--text-secondary)">No data found in spreadsheet.</div>';
      return;
    }

    // Build container
    container.innerHTML = '';

    // Tab bar (only if multiple sheets)
    if (data.sheets.length > 1) {
      const tabBar = document.createElement('div');
      tabBar.className = 'spreadsheet-tabs';
      data.sheets.forEach((sheet, i) => {
        const tab = document.createElement('button');
        tab.className = 'spreadsheet-tab' + (i === 0 ? ' active' : '');
        tab.textContent = sheet.name;
        tab.onclick = () => switchSheet(container, data.sheets, i);
        tabBar.appendChild(tab);
      });
      container.appendChild(tabBar);
    }

    // Table container
    const tableWrap = document.createElement('div');
    tableWrap.className = 'spreadsheet-table-wrap';
    tableWrap.id = 'spreadsheet-table-wrap';
    container.appendChild(tableWrap);

    // Render first sheet
    renderSheet(tableWrap, data.sheets[0]);

  } catch (e) {
    container.innerHTML = `<div style="padding:24px;color:var(--red)">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function switchSheet(container, sheets, index) {
  // Update tab active state
  const tabs = container.querySelectorAll('.spreadsheet-tab');
  tabs.forEach((t, i) => t.classList.toggle('active', i === index));

  // Re-render table
  const wrap = container.querySelector('#spreadsheet-table-wrap');
  renderSheet(wrap, sheets[index]);
}

function renderSheet(wrap, sheet) {
  wrap.innerHTML = '';

  if (!sheet.headers || sheet.headers.length === 0) {
    wrap.innerHTML = '<div style="padding:24px;color:var(--text-secondary)">Empty sheet</div>';
    return;
  }

  // Truncation notice
  if (sheet.truncated) {
    const notice = document.createElement('div');
    notice.className = 'spreadsheet-truncated';
    notice.innerHTML = `<i class="ph ph-info"></i> Showing ${sheet.rows.length} of ${sheet.totalRows} rows`;
    wrap.appendChild(notice);
  }

  // Build table
  const table = document.createElement('table');
  table.className = 'spreadsheet-table';

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  // Row number column
  const thNum = document.createElement('th');
  thNum.className = 'row-num';
  thNum.textContent = '#';
  headerRow.appendChild(thNum);
  sheet.headers.forEach(h => {
    const th = document.createElement('th');
    th.textContent = h || '';
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  sheet.rows.forEach((row, rowIdx) => {
    const tr = document.createElement('tr');
    // Row number
    const tdNum = document.createElement('td');
    tdNum.className = 'row-num';
    tdNum.textContent = String(rowIdx + 2); // +2 because row 1 is headers
    tr.appendChild(tdNum);
    // Pad row to header length
    for (let i = 0; i < sheet.headers.length; i++) {
      const td = document.createElement('td');
      const val = row[i] ?? '';
      td.textContent = val;
      if (val && !isNaN(Number(val))) td.style.textAlign = 'right';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  wrap.appendChild(table);
}
