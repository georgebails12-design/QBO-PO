// PO Requests page: submit a request for review, and work the review queue.
// A request becomes a real PO on the Purchase Order page (/?request=N), which
// fills itself in from the request so nothing gets typed twice.

const rq = {
  vendors: [], items: [], customers: [],
  vendor: null,                  // {id, name}
  customer: { id: null, name: '' },
  rows: [],
  nextRowId: 1,
  current: null,                 // request open in the detail card
};

// ---------------------------------------------------------------------
// New request form
// ---------------------------------------------------------------------
function addRequestRow() {
  const id = rq.nextRowId++;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><div class="typeahead"><input type="text" autocomplete="off" placeholder="Item, or describe it"><div class="suggestions"></div></div></td>
    <td><input type="text"></td>
    <td><input type="number" step="0.01" value="1" style="width:60px;"></td>
    <td><input type="number" step="0.01" value="0.00" style="width:80px;"></td>
    <td class="amount-cell">0.00</td>
    <td><button type="button" class="row-remove">×</button></td>
  `;
  document.getElementById('rq-lines-body').appendChild(tr);

  const row = {
    id, itemId: null,
    itemInput: tr.children[0].querySelector('input'),
    descInput: tr.children[1].querySelector('input'),
    qtyInput: tr.children[2].querySelector('input'),
    rateInput: tr.children[3].querySelector('input'),
    amountCell: tr.children[4],
  };
  rq.rows.push(row);

  function recalc() {
    row.amountCell.textContent = fmtMoney((parseFloat(row.qtyInput.value) || 0) * (parseFloat(row.rateInput.value) || 0));
    updateRequestTotal();
  }
  function extendIfLast() {
    if (row === rq.rows[rq.rows.length - 1]) addRequestRow();
  }

  attachTypeahead({
    input: row.itemInput, box: tr.children[0].querySelector('.suggestions'),
    source: () => rq.items, filter: itemFilter, render: itemLabel,
    onPick: (it) => {
      row.itemId = it.id;
      row.itemInput.value = it.name;
      row.descInput.value = it.description || '';
      const price = it.purchase_cost != null ? it.purchase_cost : it.unit_price;
      row.rateInput.value = typeof price === 'number' ? price.toFixed(2) : '0.00';
      recalc();
      extendIfLast();
    },
  });
  row.itemInput.addEventListener('input', () => { row.itemId = null; clearDuplicateWarning(); });
  row.itemInput.addEventListener('change', extendIfLast);
  row.descInput.addEventListener('change', () => { clearDuplicateWarning(); extendIfLast(); });
  row.qtyInput.addEventListener('input', recalc);
  row.rateInput.addEventListener('input', recalc);

  tr.querySelector('.row-remove').addEventListener('click', () => {
    if (rq.rows.length <= 1) {
      row.itemId = null; row.itemInput.value = ''; row.descInput.value = '';
      row.qtyInput.value = '1'; row.rateInput.value = '0.00'; recalc();
      return;
    }
    tr.remove();
    rq.rows = rq.rows.filter((r) => r.id !== id);
    updateRequestTotal();
  });
  return row;
}

function updateRequestTotal() {
  const total = rq.rows.reduce((sum, r) => sum + (parseFloat(r.qtyInput.value) || 0) * (parseFloat(r.rateInput.value) || 0), 0);
  document.getElementById('rq-total').textContent = `Est. Total: $${fmtMoney(total)}`;
}

function clearDuplicateWarning() {
  document.getElementById('rq-dup-warning').style.display = 'none';
  document.getElementById('rq-submit-anyway').style.display = 'none';
}

function setupRequestForm() {
  const vendorInput = document.getElementById('rq-vendor');
  attachTypeahead({
    input: vendorInput, box: document.getElementById('rq-vendor-suggestions'),
    source: () => rq.vendors, filter: vendorFilter, render: (v) => v.name,
    onPick: (v) => { rq.vendor = { id: v.id, name: v.name }; vendorInput.value = v.name; clearDuplicateWarning(); },
  });
  vendorInput.addEventListener('input', () => { rq.vendor = null; });

  const customerInput = document.getElementById('rq-customer');
  attachTypeahead({
    input: customerInput, box: document.getElementById('rq-customer-suggestions'),
    source: () => rq.customers, filter: customerFilter, render: (c) => c.name,
    onPick: (c) => { rq.customer = { id: c.id, name: c.name }; customerInput.value = c.name; },
  });
  customerInput.addEventListener('input', () => { rq.customer = { id: null, name: '' }; });
  document.getElementById('rq-q-project').addEventListener('input', clearDuplicateWarning);

  document.getElementById('rq-submit').addEventListener('click', () => submitRequest(false));
  document.getElementById('rq-submit-anyway').addEventListener('click', () => submitRequest(true));
  addRequestRow();
}

function submitRequest(confirmDuplicate) {
  const statusEl = document.getElementById('rq-form-status');
  if (!rq.vendor) { statusEl.textContent = 'Pick a vendor from the list.'; return; }
  const lines = rq.rows
    .filter((r) => r.itemId || r.itemInput.value.trim() || r.descInput.value.trim())
    .map((r) => ({
      item_id: r.itemId, item_name: r.itemInput.value.trim(), description: r.descInput.value.trim(),
      qty: parseFloat(r.qtyInput.value) || 0, rate: parseFloat(r.rateInput.value) || 0,
    }));
  if (!lines.length) { statusEl.textContent = 'Add at least one line.'; return; }

  statusEl.textContent = 'Submitting...';
  fetch('/api/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vendor_id: rq.vendor.id, vendor_name: rq.vendor.name,
      customer: rq.customer,
      q_project: document.getElementById('rq-q-project').value.trim(),
      needed_by: document.getElementById('rq-needed-by').value,
      memo: document.getElementById('rq-memo').value.trim(),
      lines,
      confirm_duplicate: confirmDuplicate,
    }),
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.duplicates) {
      showDuplicateWarning(data.duplicates);
      statusEl.textContent = '';
      return;
    }
    if (res.status === 401) {
      window.open('/login', '_blank');
      throw new Error('Your login expired. Log in again in the new tab, then retry here -- nothing on this page was lost.');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    statusEl.textContent = `Submitted as request #${data.number}.`;
    resetRequestForm();
    loadQueue();
  }).catch((e) => { statusEl.textContent = e.message; });
}

function showDuplicateWarning(duplicates) {
  const el = document.getElementById('rq-dup-warning');
  el.innerHTML = '<strong>This looks like something that was already requested:</strong><ul>'
    + duplicates.map((d) => {
      const state = d.status === 'converted' ? `already PO ${escapeHtml(d.po_doc_number || '')}` : 'waiting for review';
      return `<li><a href="#" data-request="${d.number}">Request #${d.number}</a> by ${escapeHtml(d.submitted_by)} `
        + `(${state}): ${escapeHtml(d.reasons.join(', '))}</li>`;
    }).join('')
    + '</ul>If it really is a separate order, click Submit Anyway.';
  el.querySelectorAll('a[data-request]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    openRequest(Number(a.dataset.request));
  }));
  el.style.display = 'block';
  document.getElementById('rq-submit-anyway').style.display = '';
}

function resetRequestForm() {
  clearDuplicateWarning();
  rq.vendor = null;
  rq.customer = { id: null, name: '' };
  ['rq-vendor', 'rq-customer', 'rq-q-project', 'rq-needed-by', 'rq-memo'].forEach((id) => {
    document.getElementById(id).value = '';
  });
  document.getElementById('rq-lines-body').innerHTML = '';
  rq.rows = [];
  addRequestRow();
  updateRequestTotal();
}

// ---------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------
function requestTotal(req) {
  return req.lines.reduce((sum, l) => sum + (l.qty || 0) * (l.rate || 0), 0);
}

function statusLabel(req) {
  if (req.status === 'converted') return `PO ${escapeHtml(req.po_doc_number || req.po_id || '')}`;
  if (req.status === 'rejected') return 'Rejected';
  const dupes = (req.similar_requests || []).length;
  return dupes ? `Open <span class="badge-warn">possible duplicate</span>` : 'Open';
}

function loadQueue() {
  const status = document.getElementById('rq-status-filter').value;
  const statusEl = document.getElementById('rq-list-status');
  const tbody = document.getElementById('rq-list-body');
  api(`/api/requests${status ? `?status=${status}` : ''}`).then((list) => {
    tbody.innerHTML = '';
    statusEl.textContent = list.length ? '' : 'Nothing here.';
    list.forEach((req) => {
      const tr = document.createElement('tr');
      tr.className = 'clickable-row';
      tr.innerHTML = `<td>${req.number}</td><td>${escapeHtml(req.vendor_name)}</td><td>${escapeHtml(req.q_project)}</td>
        <td>${req.lines.length}</td><td class="amount-cell">$${fmtMoney(requestTotal(req))}</td>
        <td>${escapeHtml(req.submitted_by)}<br><span class="hint">${new Date(req.submitted_at * 1000).toLocaleDateString()}</span></td>
        <td>${statusLabel(req)}</td>`;
      tr.addEventListener('click', () => openRequest(req.number));
      tbody.appendChild(tr);
    });
  }).catch((e) => { statusEl.textContent = e.message; });
}

function openRequest(number) {
  api(`/api/requests/${number}`).then((req) => {
    rq.current = req;
    renderDetail(req);
    const card = document.getElementById('rq-detail-card');
    card.style.display = 'block';
    card.scrollIntoView({ behavior: 'smooth' });
    if (req.status !== 'converted') checkQuickBooks(req);
  }).catch((e) => alert(e.message));
}

function renderDetail(req) {
  document.getElementById('rq-detail-title').textContent = `Request #${req.number} -- ${req.vendor_name}`;
  const facts = [
    ['Submitted', `${req.submitted_by}, ${new Date(req.submitted_at * 1000).toLocaleString()}`],
    ['Needed by', req.needed_by], ['Q#/Project', req.q_project],
    ['Customer/Project', req.customer && req.customer.name], ['Notes', req.memo],
  ];
  if (req.status === 'converted') facts.push(['Turned into', `PO ${req.po_doc_number || req.po_id} by ${req.reviewed_by}`]);
  if (req.status === 'rejected') facts.push(['Rejected', `by ${req.reviewed_by}${req.note ? `: ${req.note}` : ''}`]);
  document.getElementById('rq-detail-summary').innerHTML = facts
    .filter(([, v]) => v)
    .map(([k, v]) => `<div><span class="hint">${k}</span> ${escapeHtml(v)}</div>`).join('');

  document.getElementById('rq-detail-lines').innerHTML = req.lines.map((l) => `
    <tr><td>${escapeHtml(l.item_name)}${l.item_id ? '' : ' <span class="badge-warn">no QB item</span>'}</td>
      <td>${escapeHtml(l.description)}</td><td>${l.qty}</td><td>${fmtMoney(l.rate || 0)}</td>
      <td class="amount-cell">${fmtMoney((l.qty || 0) * (l.rate || 0))}</td></tr>`).join('')
    + `<tr><td colspan="4" class="amount-cell"><strong>Est. Total</strong></td>
      <td class="amount-cell"><strong>$${fmtMoney(requestTotal(req))}</strong></td></tr>`;

  document.getElementById('rq-create-po-btn').style.display = req.status === 'open' ? '' : 'none';
  document.getElementById('rq-reject-btn').style.display = req.status === 'open' ? '' : 'none';
  document.getElementById('rq-reopen-btn').style.display = req.status === 'rejected' ? '' : 'none';
  renderDuplicates(req, req.status === 'converted' ? { skipped: true } : null);
}

function renderDuplicates(req, qbo) {
  const el = document.getElementById('rq-detail-duplicates');
  const items = (req.similar_requests || []).map((m) => {
    const what = m.status === 'converted' ? `already PO ${escapeHtml(m.po_doc_number || '')}` : 'also waiting for review';
    return `<li><a href="#" data-request="${m.number}">Request #${m.number}</a> (${what}): ${escapeHtml(m.reasons.join(', '))}</li>`;
  });
  let qboNote = '';
  if (qbo && qbo.error) qboNote = `Could not check QuickBooks: ${escapeHtml(qbo.error)}`;
  else if (qbo && qbo.skipped) qboNote = '';
  else if (qbo) {
    qbo.matches.forEach((m) => items.push(`<li>QuickBooks PO ${escapeHtml(m.doc_number || m.id)} `
      + `(${escapeHtml(m.txn_date || '')}, $${fmtMoney(Number(m.total || 0))}, ${escapeHtml(m.status || '')}): `
      + `${escapeHtml(m.reasons.join(', '))}</li>`));
    qboNote = `Checked ${escapeHtml(req.vendor_name)}'s last ${qbo.checked} PO(s) in QuickBooks.`;
  } else qboNote = 'Checking QuickBooks for similar POs from this vendor...';

  el.className = `request-banner${items.length ? ' warn' : ''}`;
  el.innerHTML = (items.length ? `<strong>Possible duplicates:</strong><ul>${items.join('')}</ul>` : '<strong>No duplicates found.</strong> ')
    + (qboNote ? `<span class="hint">${qboNote}</span>` : '');
  el.querySelectorAll('a[data-request]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    openRequest(Number(a.dataset.request));
  }));
}

function checkQuickBooks(req) {
  api(`/api/requests/${req.number}/qbo-duplicates`)
    .then((qbo) => { if (rq.current && rq.current.number === req.number) renderDuplicates(req, qbo); })
    .catch((e) => { if (rq.current && rq.current.number === req.number) renderDuplicates(req, { error: e.message }); });
}

function setStatusOfCurrent(status, note) {
  api(`/api/requests/${rq.current.number}/status`, { method: 'POST', body: JSON.stringify({ status, note }) })
    .then(() => { openRequest(rq.current.number); loadQueue(); })
    .catch((e) => alert(e.message));
}

function setupQueue() {
  document.getElementById('rq-status-filter').addEventListener('change', loadQueue);
  document.getElementById('rq-close-btn').addEventListener('click', () => {
    document.getElementById('rq-detail-card').style.display = 'none';
    rq.current = null;
  });
  document.getElementById('rq-create-po-btn').addEventListener('click', () => {
    window.location = `/?request=${rq.current.number}`;
  });
  document.getElementById('rq-reject-btn').addEventListener('click', () => {
    const note = prompt(`Reject request #${rq.current.number}? Optional reason (e.g. "duplicate of #12"):`, '');
    if (note === null) return;
    setStatusOfCurrent('rejected', note);
  });
  document.getElementById('rq-reopen-btn').addEventListener('click', () => setStatusOfCurrent('open', ''));
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  setupRequestForm();
  setupQueue();
  loadQueue();
  api('/api/reference').then((data) => {
    rq.vendors = data.vendors || [];
    rq.items = data.items || [];
    rq.customers = data.customers || [];
    if (!data.fetched_at) {
      document.getElementById('rq-form-status').textContent =
        'Vendor/item lists haven\'t been loaded yet -- open the Purchase Order page once to load them from QuickBooks.';
    }
  }).catch((e) => { document.getElementById('rq-form-status').textContent = e.message; });
});
