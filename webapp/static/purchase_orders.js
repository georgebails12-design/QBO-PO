// View Purchase Orders page logic: search/browse existing POs, view one, manage its attachments.

let currentPoId = null;

function api(path, opts) {
  return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts))
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
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
  const card = document.getElementById('po-detail-card');
  card.style.display = 'block';
  document.getElementById('po-detail-title').textContent = 'Loading...';
  api(`/api/purchase-orders/${id}`)
    .then((po) => {
      document.getElementById('po-detail-title').textContent = `PO #${po.doc_number || po.id}`;
      document.getElementById('po-detail-summary').innerHTML = `
        <p><strong>Vendor:</strong> ${escapeHtml(po.vendor)}
        &nbsp;&nbsp;<strong>Date:</strong> ${escapeHtml(po.txn_date)}
        &nbsp;&nbsp;<strong>Status:</strong> ${escapeHtml(po.status)}
        &nbsp;&nbsp;<strong>Total:</strong> ${money(po.total)}</p>
        ${po.q_project ? `<p><strong>Q#/Project:</strong> ${escapeHtml(po.q_project)}</p>` : ''}
        ${po.memo ? `<p><strong>Memo:</strong> ${escapeHtml(po.memo)}</p>` : ''}
      `;

      const linesBody = document.getElementById('po-detail-lines-body');
      linesBody.innerHTML = '';
      (po.lines || []).forEach((line) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${escapeHtml(line.name)}</td><td>${escapeHtml(line.description)}</td>
          <td>${line.kind === 'item' && line.qty != null ? escapeHtml(line.qty) : ''}</td>
          <td>${line.kind === 'item' && line.rate != null ? money(line.rate) : ''}</td>
          <td class="amount-cell">${money(line.amount)}</td>`;
        linesBody.appendChild(tr);
      });

      renderAttachments(po.attachments || []);
    })
    .catch((e) => {
      document.getElementById('po-detail-title').textContent = 'Purchase Order';
      document.getElementById('po-detail-summary').innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
      document.getElementById('po-detail-lines-body').innerHTML = '';
    });
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
