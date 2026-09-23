// View Purchase Orders page logic: search/browse existing POs, view/edit one, manage its attachments.

let currentPoId = null;
let currentPo = null;   // last-loaded PO data from the server (read-model)
let editing = false;
let editRows = [];      // populated while editing: [{kind, id (item_id/account_id), descInput, qtyInput, rateInput, amountInput, amountCell}]

function api(path, opts) {
  return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts))
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        // Session expired: log in again in a new tab so nothing typed on this page is lost.
        window.open('/login', '_blank');
        throw new Error('Your login expired. Log in again in the new tab, then retry here -- nothing on this page was lost.');
      }
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data;
    });
}

function escapeHtml(s) {
  return (s || '').toString().replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(n) {
  const v = Number(n || 0);
  return `$${v.toFixed(2)}`;
}

function formatBytes(n) {
  const v = Number(n || 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

function runSearch() {
  const docNumber = document.getElementById('po-search-docnumber').value.trim();
  const statusEl = document.getElementById('po-search-status');
  const tbody = document.getElementById('po-search-table-body');
  statusEl.textContent = 'Searching...';
  const qs = docNumber ? `?doc_number=${encodeURIComponent(docNumber)}` : '';
  api(`/api/purchase-orders${qs}`)
    .then((results) => {
      tbody.innerHTML = '';
      if (!results.length) {
        statusEl.textContent = 'No purchase orders found.';
        return;
      }
      statusEl.textContent = `${results.length} result(s).`;
      results.forEach((po) => {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.innerHTML = `<td>${escapeHtml(po.doc_number || po.id)}</td><td>${escapeHtml(po.vendor)}</td>
          <td>${escapeHtml(po.txn_date)}</td><td>${escapeHtml(po.status)}</td><td class="amount-cell">${money(po.total)}</td>`;
        tr.addEventListener('click', () => loadDetail(po.id));
        tbody.appendChild(tr);
      });
    })
    .catch((e) => { statusEl.textContent = e.message; });
}

function loadDetail(id) {
  currentPoId = id;
  editing = false;
  const card = document.getElementById('po-detail-card');
  card.style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  document.getElementById('po-detail-title').textContent = 'Loading...';
  document.getElementById('po-detail-pdf-btn').onclick = () => window.open(`/api/purchase-orders/${id}/pdf`, '_blank');
  api(`/api/purchase-orders/${id}`)
    .then((po) => {
      currentPo = po;
      renderDetail();
      renderAttachments(po.attachments || []);
    })
    .catch((e) => {
      document.getElementById('po-detail-title').textContent = 'Purchase Order';
      document.getElementById('po-detail-summary').innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
      document.getElementById('po-detail-lines-body').innerHTML = '';
    });
}

function renderDetail() {
  const po = currentPo;
  document.getElementById('po-detail-title').textContent = `PO #${po.doc_number || po.id}`;
  document.getElementById('po-detail-edit-btn').style.display = editing ? 'none' : '';
  document.getElementById('po-detail-pdf-btn').style.display = editing ? 'none' : '';
  document.getElementById('po-detail-save-btn').style.display = editing ? '' : 'none';
  document.getElementById('po-detail-cancel-btn').style.display = editing ? '' : 'none';
  document.getElementById('po-detail-status').textContent = '';

  const summary = document.getElementById('po-detail-summary');
  if (!editing) {
    summary.innerHTML = `
      <p><strong>Vendor:</strong> ${escapeHtml(po.vendor)}
      &nbsp;&nbsp;<strong>Date:</strong> ${escapeHtml(po.txn_date)}
      &nbsp;&nbsp;<strong>Status:</strong> ${escapeHtml(po.status)}
      &nbsp;&nbsp;<strong>Total:</strong> <span id="po-detail-total">${money(po.total)}</span></p>
      ${po.q_project ? `<p><strong>Q#/Project:</strong> ${escapeHtml(po.q_project)}</p>` : ''}
      ${po.memo ? `<p><strong>Memo:</strong> ${escapeHtml(po.memo)}</p>` : ''}
    `;
  } else {
    summary.innerHTML = `
      <div class="field-row">
        <div class="field"><span><strong>Vendor:</strong> ${escapeHtml(po.vendor)} (not editable)</span></div>
        <label class="field small">PO Date<input type="date" id="edit-po-date" value="${escapeHtml(po.txn_date)}"></label>
      </div>
      <div class="field-row">
        <label class="field wide">Memo<input type="text" id="edit-memo" value="${escapeHtml(po.memo)}"></label>
        <label class="field">Q#/Project<input type="text" id="edit-q-project" value="${escapeHtml(po.q_project)}"></label>
      </div>
      <p><strong>Total:</strong> <span id="po-detail-total">${money(po.total)}</span></p>
    `;
  }

  const linesBody = document.getElementById('po-detail-lines-body');
  linesBody.innerHTML = '';
  editRows = [];
  (po.lines || []).forEach((line) => {
    const tr = document.createElement('tr');
    if (!editing) {
      tr.innerHTML = `<td>${escapeHtml(line.name)}</td><td>${escapeHtml(line.description)}</td>
        <td>${line.kind === 'item' && line.qty != null ? escapeHtml(line.qty) : ''}</td>
        <td>${line.kind === 'item' && line.rate != null ? money(line.rate) : ''}</td>
        <td class="amount-cell">${money(line.amount)}</td><td></td>`;
      linesBody.appendChild(tr);
      return;
    }

    const row = { kind: line.kind, id: line.kind === 'item' ? line.item_id : line.account_id, customer: line.customer_id };
    const nameCell = document.createElement('td');
    nameCell.textContent = line.name;
    const descCell = document.createElement('td');
    row.descInput = document.createElement('input');
    row.descInput.type = 'text';
    row.descInput.value = line.description || '';
    descCell.appendChild(row.descInput);
    const qtyCell = document.createElement('td');
    const rateCell = document.createElement('td');
    const amountCell = document.createElement('td');
    amountCell.className = 'amount-cell';
    row.amountCell = amountCell;

    if (line.kind === 'item') {
      row.qtyInput = document.createElement('input');
      row.qtyInput.type = 'number'; row.qtyInput.step = '0.01'; row.qtyInput.value = line.qty != null ? line.qty : '';
      qtyCell.appendChild(row.qtyInput);
      row.rateInput = document.createElement('input');
      row.rateInput.type = 'number'; row.rateInput.step = '0.01'; row.rateInput.value = line.rate != null ? line.rate : 0;
      rateCell.appendChild(row.rateInput);
      const recompute = () => {
        const amt = (parseFloat(row.qtyInput.value) || 0) * (parseFloat(row.rateInput.value) || 0);
        amountCell.textContent = money(amt);
        updateEditTotal();
      };
      row.qtyInput.addEventListener('input', recompute);
      row.rateInput.addEventListener('input', recompute);
      amountCell.textContent = money(line.amount);
    } else {
      row.amountInput = document.createElement('input');
      row.amountInput.type = 'number'; row.amountInput.step = '0.01'; row.amountInput.value = line.amount != null ? line.amount : 0;
      row.amountInput.addEventListener('input', updateEditTotal);
      amountCell.appendChild(row.amountInput);
    }

    const removeCell = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button'; removeBtn.className = 'row-remove'; removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      const idx = editRows.indexOf(row);
      if (idx >= 0) editRows.splice(idx, 1);
      tr.remove();
      updateEditTotal();
    });
    removeCell.appendChild(removeBtn);

    tr.appendChild(nameCell); tr.appendChild(descCell); tr.appendChild(qtyCell);
    tr.appendChild(rateCell); tr.appendChild(amountCell); tr.appendChild(removeCell);
    linesBody.appendChild(tr);
    editRows.push(row);
  });
}

function updateEditTotal() {
  let total = 0;
  editRows.forEach((row) => {
    if (row.kind === 'item') {
      total += (parseFloat(row.qtyInput.value) || 0) * (parseFloat(row.rateInput.value) || 0);
    } else {
      total += parseFloat(row.amountInput.value) || 0;
    }
  });
  const totalEl = document.getElementById('po-detail-total');
  if (totalEl) totalEl.textContent = money(total);
}

function startEdit() {
  editing = true;
  renderDetail();
}

function cancelEdit() {
  editing = false;
  renderDetail();
}

function saveEdit() {
  const statusEl = document.getElementById('po-detail-status');
  if (!editRows.length) { statusEl.textContent = 'A purchase order needs at least one line.'; return; }

  const item_lines = [];
  const category_lines = [];
  editRows.forEach((row) => {
    if (row.kind === 'item') {
      item_lines.push({
        item_id: row.id, description: row.descInput.value.trim(),
        qty: parseFloat(row.qtyInput.value) || 0, unit_price: parseFloat(row.rateInput.value) || 0,
        customer_id: row.customer,
      });
    } else {
      category_lines.push({
        account_id: row.id, description: row.descInput.value.trim(),
        amount: parseFloat(row.amountInput.value) || 0, customer_id: row.customer,
      });
    }
  });

  statusEl.textContent = 'Saving...';
  api(`/api/purchase-orders/${currentPoId}`, {
    method: 'PUT',
    body: JSON.stringify({
      item_lines, category_lines,
      memo: document.getElementById('edit-memo').value.trim(),
      txn_date: document.getElementById('edit-po-date').value,
      q_project: document.getElementById('edit-q-project').value.trim(),
    }),
  }).then((po) => {
    currentPo = po;
    editing = false;
    renderDetail();
    renderAttachments(po.attachments || []);
    document.getElementById('po-detail-status').textContent = 'Saved.';
    runSearch();
  }).catch((e) => { statusEl.textContent = e.message; });
}

function renderAttachments(attachments) {
  const tbody = document.getElementById('attachments-table-body');
  tbody.innerHTML = '';
  if (!attachments.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="hint">No attachments yet.</td></tr>';
    return;
  }
  attachments.forEach((att) => {
    const tr = document.createElement('tr');
    const created = att.created ? att.created.slice(0, 10) : '';
    tr.innerHTML = `<td><a href="/api/attachments/${att.id}/download" target="_blank">${escapeHtml(att.file_name)}</a></td>
      <td>${formatBytes(att.size)}</td><td>${escapeHtml(created)}</td>
      <td><button type="button" class="row-remove attachment-delete" title="Delete">&times;</button></td>`;
    tr.querySelector('.attachment-delete').addEventListener('click', () => deleteAttachment(att.id));
    tbody.appendChild(tr);
  });
}

function deleteAttachment(attachableId) {
  if (!confirm('Delete this attachment?')) return;
  api(`/api/attachments/${attachableId}`, { method: 'DELETE' })
    .then(() => loadDetail(currentPoId))
    .catch((e) => alert(e.message));
}

function uploadAttachment(file) {
  if (!currentPoId) return;
  const statusEl = document.getElementById('attachment-status');
  statusEl.textContent = `Uploading ${file.name}...`;
  const formData = new FormData();
  formData.append('file', file);
  fetch(`/api/purchase-orders/${currentPoId}/attachments`, { method: 'POST', body: formData })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      statusEl.textContent = '';
      loadDetail(currentPoId);
    })
    .catch((e) => { statusEl.textContent = e.message; });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('po-search-btn').addEventListener('click', runSearch);
  document.getElementById('po-search-docnumber').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });
  document.getElementById('po-detail-edit-btn').addEventListener('click', startEdit);
  document.getElementById('po-detail-cancel-btn').addEventListener('click', cancelEdit);
  document.getElementById('po-detail-save-btn').addEventListener('click', saveEdit);
  document.getElementById('attachment-upload-btn').addEventListener('click', () => {
    document.getElementById('attachment-file-input').click();
  });
  document.getElementById('attachment-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) uploadAttachment(file);
    e.target.value = '';
  });
  runSearch();
});
