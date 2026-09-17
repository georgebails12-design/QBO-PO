// Purchase Order page logic. Vanilla JS, no framework -- mirrors the
// desktop Tkinter app's behavior (type-ahead everywhere, spreadsheet-style
// grids that auto-extend with a blank row).

const state = {
  vendors: [], items: [], accounts: [], customers: [],
  categories: {},
  vendorId: null,
  headerCustomer: { id: null, name: '' },
  itemRows: [],
  categoryRows: [],
  nextRowId: 1,
};

function api(path, opts) {
  return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts))
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data;
    });
}

function fmtMoney(n) { return (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2); }

// ---------------------------------------------------------------------
// Generic type-ahead
// ---------------------------------------------------------------------
function attachTypeahead({ input, box, source, filter, render, onPick }) {
  let matches = [];
  function hide() { box.classList.remove('open'); box.innerHTML = ''; }
  function show() {
    box.innerHTML = '';
    matches.forEach((item) => {
      const div = document.createElement('div');
      div.className = 'suggestion';
      div.textContent = render(item);
      div.addEventListener('mousedown', (e) => { e.preventDefault(); onPick(item); hide(); });
      box.appendChild(div);
    });
    box.classList.toggle('open', matches.length > 0);
  }
  input.addEventListener('input', () => {
    const term = input.value.trim().toLowerCase();
    if (!term) { hide(); return; }
    matches = source().filter((it) => filter(it, term)).slice(0, 8);
    show();
  });
  input.addEventListener('blur', () => setTimeout(hide, 150));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}

function vendorFilter(v, term) { return v.name.toLowerCase().includes(term); }
function itemFilter(it, term) {
  return it.name.toLowerCase().includes(term) || (it.description || '').toLowerCase().includes(term);
}
function accountFilter(a, term) {
  return a.name.toLowerCase().includes(term) || (a.account_type || '').toLowerCase().includes(term);
}
function customerFilter(c, term) { return c.name.toLowerCase().includes(term); }

function itemLabel(it) {
  const price = it.purchase_cost != null ? it.purchase_cost : it.unit_price;
  const priceStr = typeof price === 'number' ? price.toFixed(2) : '--';
  const desc = (it.description || '').trim();
  return (desc ? `${it.name} — ${desc}` : it.name) + `  ($${priceStr})`;
}
function accountLabel(a) { return `${a.name} (${a.account_type || ''})`; }

// ---------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------
function setStatus(text) { document.getElementById('reference-status').textContent = text; }

function loadReference() {
  return api('/api/reference').then((data) => {
    state.vendors = data.vendors || [];
    state.items = data.items || [];
    state.accounts = data.accounts || [];
    state.customers = data.customers || [];
    if (!data.fetched_at) {
      setStatus('No cached data yet -- loading from QuickBooks (this can take a while the first time)...');
      return refreshReference();
    }
    const ageMin = Math.round((Date.now() / 1000 - data.fetched_at) / 60);
    setStatus(`Loaded ${state.vendors.length} vendors, ${state.items.length} items, ${state.accounts.length} accounts, `
      + `${state.customers.length} customers/projects (${ageMin} min old).`);
  });
}

function refreshReference() {
  setStatus('Refreshing from QuickBooks (thousands of records -- this can take a while)...');
  return api('/api/reference/refresh', { method: 'POST' }).then(({ job_id }) => pollRefresh(job_id));
}

function pollRefresh(jobId) {
  return new Promise((resolve) => {
    const tick = () => {
      api(`/api/reference/refresh/${jobId}`).then((job) => {
        if (job.status === 'running') { setTimeout(tick, 1500); return; }
        if (job.status === 'error') { setStatus(`Refresh failed: ${job.error}`); resolve(); return; }
        loadReference().then(resolve);
      });
    };
    tick();
  });
}

function loadCategories() {
  return api('/api/categories').then((cats) => { state.categories = cats; });
}

// ---------------------------------------------------------------------
// Header fields
// ---------------------------------------------------------------------
function setupHeader() {
  document.getElementById('po-date').value = new Date().toISOString().slice(0, 10);

  attachTypeahead({
    input: document.getElementById('vendor-input'),
    box: document.getElementById('vendor-suggestions'),
    source: () => state.vendors, filter: vendorFilter, render: (v) => v.name,
    onPick: (v) => { state.vendorId = v.id; document.getElementById('vendor-input').value = v.name; },
  });
  document.getElementById('vendor-input').addEventListener('input', () => { state.vendorId = null; });

  attachTypeahead({
    input: document.getElementById('header-customer-input'),
    box: document.getElementById('header-customer-suggestions'),
    source: () => state.customers, filter: customerFilter, render: (c) => c.name,
    onPick: (c) => {
      state.headerCustomer = { id: c.id, name: c.name };
      document.getElementById('header-customer-input').value = c.name;
    },
  });
  document.getElementById('header-customer-input').addEventListener('input', () => {
    state.headerCustomer = { id: null, name: '' };
  });

  document.getElementById('apply-customer-all').addEventListener('click', () => {
    if (!state.headerCustomer.id) { alert('Pick a Customer/Project first.'); return; }
    [...state.itemRows, ...state.categoryRows].forEach((row) => {
      row.customerId = state.headerCustomer.id;
      row.customerInput.value = state.headerCustomer.name;
    });
  });

  document.getElementById('suggest-po-number').addEventListener('click', () => {
    api('/api/po-number/suggest').then(({ next }) => {
      if (next) document.getElementById('po-number').value = next;
      else alert('Could not suggest a PO number -- enter one manually.');
    }).catch((e) => alert(e.message));
  });
}

function suggestPoNumberOnLoad() {
  api('/api/po-number/suggest').then(({ next }) => {
    if (next && !document.getElementById('po-number').value) document.getElementById('po-number').value = next;
  }).catch(() => {});
}

// ---------------------------------------------------------------------
// Item Details grid
// ---------------------------------------------------------------------
function addItemRow() {
  const id = state.nextRowId++;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><div class="typeahead"><input type="text" autocomplete="off"></div></td>
    <td><input type="text"></td>
    <td><input type="number" step="0.01" value="1" style="width:60px;"></td>
    <td><input type="number" step="0.01" value="0.00" style="width:80px;"></td>
    <td class="amount-cell">0.00</td>
    <td><div class="typeahead"><input type="text" autocomplete="off"></div></td>
    <td><button type="button" class="row-remove">×</button></td>
  `;
  document.getElementById('item-grid-body').appendChild(tr);

  const itemInput = tr.children[0].querySelector('input');
  const descInput = tr.children[1].querySelector('input');
  const qtyInput = tr.children[2].querySelector('input');
  const rateInput = tr.children[3].querySelector('input');
  const amountCell = tr.children[4];
  const customerInput = tr.children[5].querySelector('input');
  const removeBtn = tr.children[6].querySelector('button');

  const itemBox = document.createElement('div');
  itemBox.className = 'suggestions';
  tr.children[0].querySelector('.typeahead').appendChild(itemBox);
  const customerBox = document.createElement('div');
  customerBox.className = 'suggestions';
  tr.children[5].querySelector('.typeahead').appendChild(customerBox);

  const row = {
    id, itemId: null, itemInput, descInput, qtyInput, rateInput, amountCell, customerInput,
    customerId: null,
  };
  state.itemRows.push(row);

  function recalc() {
    const qty = parseFloat(qtyInput.value) || 0;
    const rate = parseFloat(rateInput.value) || 0;
    amountCell.textContent = fmtMoney(qty * rate);
    updateTotal();
  }

  attachTypeahead({
    input: itemInput, box: itemBox, source: () => state.items, filter: itemFilter, render: itemLabel,
    onPick: (it) => {
      row.itemId = it.id;
      itemInput.value = it.name;
      descInput.value = it.description || '';
      const price = it.purchase_cost != null ? it.purchase_cost : it.unit_price;
      rateInput.value = typeof price === 'number' ? price.toFixed(2) : '0.00';
      recalc();
      if (row === state.itemRows[state.itemRows.length - 1]) addItemRow();
    },
  });
  itemInput.addEventListener('input', () => { row.itemId = null; });

  attachTypeahead({
    input: customerInput, box: customerBox, source: () => state.customers, filter: customerFilter, render: (c) => c.name,
    onPick: (c) => { row.customerId = c.id; customerInput.value = c.name; },
  });
  customerInput.addEventListener('input', () => { row.customerId = null; });

  qtyInput.addEventListener('input', recalc);
  rateInput.addEventListener('input', recalc);

  removeBtn.addEventListener('click', () => {
    if (state.itemRows.length <= 1) {
      row.itemId = null; itemInput.value = ''; descInput.value = ''; qtyInput.value = '1';
      rateInput.value = '0.00'; amountCell.textContent = '0.00'; customerInput.value = ''; row.customerId = null;
      updateTotal();
      return;
    }
    tr.remove();
    state.itemRows = state.itemRows.filter((r) => r.id !== id);
    updateTotal();
  });

  return row;
}

// ---------------------------------------------------------------------
// Category Details grid
// ---------------------------------------------------------------------
function addCategoryRow() {
  const id = state.nextRowId++;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><div class="typeahead"><input type="text" autocomplete="off"></div></td>
    <td><input type="text"></td>
    <td><input type="number" step="0.01" value="0.00" style="width:90px;"></td>
    <td><div class="typeahead"><input type="text" autocomplete="off"></div></td>
    <td><button type="button" class="row-remove">×</button></td>
  `;
  document.getElementById('category-grid-body').appendChild(tr);

  const accountInput = tr.children[0].querySelector('input');
  const descInput = tr.children[1].querySelector('input');
  const amountInput = tr.children[2].querySelector('input');
  const customerInput = tr.children[3].querySelector('input');
  const removeBtn = tr.children[4].querySelector('button');

  const accountBox = document.createElement('div');
  accountBox.className = 'suggestions';
  tr.children[0].querySelector('.typeahead').appendChild(accountBox);
  const customerBox = document.createElement('div');
  customerBox.className = 'suggestions';
  tr.children[3].querySelector('.typeahead').appendChild(customerBox);

  const row = { id, accountId: null, accountInput, descInput, amountInput, customerInput, customerId: null };
  state.categoryRows.push(row);

  attachTypeahead({
    input: accountInput, box: accountBox, source: () => state.accounts, filter: accountFilter, render: accountLabel,
    onPick: (a) => {
      row.accountId = a.id; accountInput.value = a.name;
      if (row === state.categoryRows[state.categoryRows.length - 1]) addCategoryRow();
    },
  });
  accountInput.addEventListener('input', () => { row.accountId = null; });

  attachTypeahead({
    input: customerInput, box: customerBox, source: () => state.customers, filter: customerFilter, render: (c) => c.name,
    onPick: (c) => { row.customerId = c.id; customerInput.value = c.name; },
  });
  customerInput.addEventListener('input', () => { row.customerId = null; });

  amountInput.addEventListener('input', updateTotal);

  removeBtn.addEventListener('click', () => {
    if (state.categoryRows.length <= 1) {
      row.accountId = null; accountInput.value = ''; descInput.value = ''; amountInput.value = '0.00';
      customerInput.value = ''; row.customerId = null;
      updateTotal();
      return;
    }
    tr.remove();
    state.categoryRows = state.categoryRows.filter((r) => r.id !== id);
    updateTotal();
  });

  return row;
}

function updateTotal() {
  let total = 0;
  state.itemRows.forEach((r) => {
    if (!r.itemId) return;
    total += (parseFloat(r.qtyInput.value) || 0) * (parseFloat(r.rateInput.value) || 0);
  });
  state.categoryRows.forEach((r) => {
    if (!r.accountId) return;
    total += parseFloat(r.amountInput.value) || 0;
  });
  document.getElementById('total-display').textContent = `Total: $${fmtMoney(total)}`;
}

// ---------------------------------------------------------------------
// New Item dialog
// ---------------------------------------------------------------------
function setupNewItemDialog() {
  const dlg = document.getElementById('new-item-dialog');
  document.getElementById('new-item-btn').addEventListener('click', () => {
    const catNames = Object.keys(state.categories).sort();
    const sel = document.getElementById('ni-category');
    sel.innerHTML = catNames.map((c) => `<option value="${c}">${c}</option>`).join('');
    document.getElementById('ni-error').style.display = 'none';
    document.getElementById('ni-name').value = '';
    document.getElementById('ni-description').value = '';
    document.getElementById('ni-price').value = '0.00';
    document.getElementById('ni-qty').value = '1';
    if (!catNames.length) {
      document.getElementById('ni-error').textContent = 'No categories mapped yet -- go to Categories first.';
      document.getElementById('ni-error').style.display = 'block';
    }
    dlg.showModal();
  });
  document.getElementById('ni-cancel').addEventListener('click', () => dlg.close());
  document.getElementById('ni-create').addEventListener('click', () => {
    const name = document.getElementById('ni-name').value.trim();
    const category = document.getElementById('ni-category').value;
    const price = parseFloat(document.getElementById('ni-price').value) || 0;
    const qty = parseFloat(document.getElementById('ni-qty').value) || 1;
    const description = document.getElementById('ni-description').value.trim();
    const errEl = document.getElementById('ni-error');
    if (!name || !category) { errEl.textContent = 'Name and category are required.'; errEl.style.display = 'block'; return; }

    api('/api/items', { method: 'POST', body: JSON.stringify({ name, description, price, category }) })
      .then((item) => {
        state.items.push(item);
        let target = state.itemRows[state.itemRows.length - 1];
        if (target.itemId || target.itemInput.value.trim()) target = addItemRow();
        target.itemId = item.id;
        target.itemInput.value = item.name;
        target.descInput.value = item.description || '';
        target.rateInput.value = price.toFixed(2);
        target.qtyInput.value = qty;
        target.amountCell.textContent = fmtMoney(price * qty);
        updateTotal();
        if (target === state.itemRows[state.itemRows.length - 1]) addItemRow();
        dlg.close();
      })
      .catch((e) => { errEl.textContent = e.message; errEl.style.display = 'block'; });
  });
}

// ---------------------------------------------------------------------
// Import Glass PDF dialog
// ---------------------------------------------------------------------
let glassParsed = null;
let glassRows = [];

function setupGlassDialog() {
  const dlg = document.getElementById('glass-dialog');
  document.getElementById('import-glass-btn').addEventListener('click', () => {
    document.getElementById('glass-upload-step').style.display = 'block';
    document.getElementById('glass-review-step').style.display = 'none';
    document.getElementById('glass-file-input').value = '';
    document.getElementById('glass-error').style.display = 'none';
    dlg.showModal();
  });
  document.getElementById('glass-cancel').addEventListener('click', () => dlg.close());

  document.getElementById('glass-parse-btn').addEventListener('click', () => {
    const file = document.getElementById('glass-file-input').files[0];
    const errEl = document.getElementById('glass-error');
    errEl.style.display = 'none';
    if (!file) { errEl.textContent = 'Choose a PDF first.'; errEl.style.display = 'block'; return; }
    const fd = new FormData();
    fd.append('file', file);
    fetch('/api/glass-pdf', { method: 'POST', body: fd }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not parse PDF.');
      return data;
    }).then((parsed) => {
      glassParsed = parsed;
      renderGlassReview(parsed);
    }).catch((e) => { errEl.textContent = e.message; errEl.style.display = 'block'; });
  });

  document.getElementById('glass-create-items').addEventListener('click', createGlassItems);
  document.getElementById('glass-cardinal-csv').addEventListener('click', generateCardinalCsv);
}

function renderGlassReview(parsed) {
  document.getElementById('glass-upload-step').style.display = 'none';
  document.getElementById('glass-review-step').style.display = 'block';

  const bits = [];
  if (parsed.project_name) bits.push(`Project: ${parsed.project_name}`);
  if (parsed.job) bits.push(`Job #: ${parsed.job}`);
  if (parsed.jdm) bits.push(`JDM: ${parsed.jdm}`);
  document.getElementById('glass-summary').textContent =
    (bits.join('   ') || 'Parsed glass breakdown') + ` -- ${parsed.units.length} unit(s) found.`;

  const catNames = Object.keys(state.categories).sort();
  const catSel = document.getElementById('glass-category');
  catSel.innerHTML = catNames.map((c) => `<option value="${c}">${c}</option>`).join('');

  const tbody = document.getElementById('glass-grid-body');
  tbody.innerHTML = '';
  glassRows = parsed.units.map((unit, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" checked></td>
      <td><input type="text" value="${escapeHtml(unit.name)}"></td>
      <td><input type="text" value="${escapeHtml(unit.description)}"></td>
      <td><input type="number" step="0.01" value="${unit.qty}" style="width:60px;"></td>
      <td><input type="number" step="0.01" value="0.00" style="width:80px;"></td>
      <td>${escapeHtml((unit.flags || []).join('; '))}</td>
    `;
    tbody.appendChild(tr);
    return {
      unit, includeInput: tr.children[0].querySelector('input'),
      nameInput: tr.children[1].querySelector('input'), descInput: tr.children[2].querySelector('input'),
      qtyInput: tr.children[3].querySelector('input'), priceInput: tr.children[4].querySelector('input'),
    };
  });
  document.getElementById('glass-status').textContent = '';
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function createGlassItems() {
  const category = document.getElementById('glass-category').value;
  const statusEl = document.getElementById('glass-status');
  if (!category) { statusEl.textContent = 'Choose a category first.'; return; }
  const selected = glassRows.filter((r) => r.includeInput.checked);
  if (!selected.length) { statusEl.textContent = 'Nothing selected.'; return; }

  statusEl.textContent = `Creating ${selected.length} item(s) in QuickBooks...`;
  let chain = Promise.resolve();
  const created = [];
  selected.forEach((r) => {
    chain = chain.then(() => api('/api/items', {
      method: 'POST',
      body: JSON.stringify({
        name: r.nameInput.value.trim(), description: r.descInput.value.trim(),
        price: parseFloat(r.priceInput.value) || 0, category,
      }),
    }).then((item) => {
      state.items.push(item);
      created.push({ item, qty: parseFloat(r.qtyInput.value) || 1 });
    }));
  });
  chain.then(() => {
    created.forEach(({ item, qty }) => {
      let target = state.itemRows[state.itemRows.length - 1];
      if (target.itemId || target.itemInput.value.trim()) target = addItemRow();
      target.itemId = item.id;
      target.itemInput.value = item.name;
      target.descInput.value = item.description || '';
      target.rateInput.value = (item.unit_price || 0).toFixed(2);
      target.qtyInput.value = qty;
      target.amountCell.textContent = fmtMoney((item.unit_price || 0) * qty);
    });
    if (state.itemRows[state.itemRows.length - 1].itemId) addItemRow();
    updateTotal();
    statusEl.textContent = `Created ${created.length} item(s) and added them to the PO.`;
  }).catch((e) => { statusEl.textContent = `Error: ${e.message}`; });
}

function generateCardinalCsv() {
  const selected = glassRows.filter((r) => r.includeInput.checked);
  const statusEl = document.getElementById('glass-status');
  if (!selected.length) { statusEl.textContent = 'Nothing selected.'; return; }
  const poNumber = prompt('Cardinal PO number for this batch:');
  if (!poNumber) return;

  api('/api/cardinal-csv', {
    method: 'POST',
    body: JSON.stringify({
      units: selected.map((r) => r.unit),
      po_number: poNumber.trim(),
      job_number: glassParsed ? glassParsed.job : null,
    }),
  }).then((res) => {
    let msg = `Wrote a CSV with ${res.count} unit(s).`;
    if (res.mismatched_spacer && res.mismatched_spacer.length) {
      msg += ` Spacer type mismatch on: ${res.mismatched_spacer.join(', ')} -- verify before sending.`;
    }
    if (res.skipped && res.skipped.length) {
      msg += ` ${res.skipped.length} unit(s) skipped.`;
    }
    statusEl.textContent = msg;
    window.location = res.download_url;
  }).catch((e) => { statusEl.textContent = `Error: ${e.message}`; });
}

// ---------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------
function setupSubmit() {
  document.getElementById('submit-po').addEventListener('click', () => {
    if (!state.vendorId) { alert('Choose a vendor.'); return; }

    const itemLines = [];
    state.itemRows.forEach((r) => {
      if (!r.itemId) return;
      const qty = parseFloat(r.qtyInput.value) || 0;
      const rate = parseFloat(r.rateInput.value) || 0;
      if (qty <= 0) return;
      itemLines.push({ item_id: r.itemId, description: r.descInput.value.trim(), qty, unit_price: rate, customer_id: r.customerId });
    });
    const categoryLines = [];
    state.categoryRows.forEach((r) => {
      if (!r.accountId) return;
      const amount = parseFloat(r.amountInput.value) || 0;
      if (amount <= 0) return;
      categoryLines.push({ account_id: r.accountId, description: r.descInput.value.trim(), amount, customer_id: r.customerId });
    });
    if (!itemLines.length && !categoryLines.length) { alert('Add at least one line item or category line.'); return; }

    const poNumber = document.getElementById('po-number').value.trim();
    const totalText = document.getElementById('total-display').textContent;
    if (!confirm(`Create ${poNumber ? 'PO #' + poNumber : 'a purchase order'} with ${itemLines.length + categoryLines.length} `
      + `line(s), ${totalText}, in QuickBooks?`)) return;

    api('/api/purchase-order', {
      method: 'POST',
      body: JSON.stringify({
        vendor_id: state.vendorId, item_lines: itemLines, category_lines: categoryLines,
        memo: document.getElementById('memo').value.trim(),
        txn_date: document.getElementById('po-date').value,
        q_project: document.getElementById('q-project').value.trim(),
        doc_number: poNumber,
      }),
    }).then((result) => {
      alert(`Purchase Order ${result.doc_number || result.id} was created in QuickBooks.`);
      resetForm();
    }).catch((e) => alert(`Could not create purchase order:\n${e.message}`));
  });
}

function resetForm() {
  document.getElementById('memo').value = '';
  document.getElementById('q-project').value = '';
  document.getElementById('header-customer-input').value = '';
  state.headerCustomer = { id: null, name: '' };
  document.getElementById('item-grid-body').innerHTML = '';
  document.getElementById('category-grid-body').innerHTML = '';
  state.itemRows = []; state.categoryRows = [];
  addItemRow(); addCategoryRow();
  updateTotal();
  suggestPoNumberOnLoad();
  document.getElementById('po-number').value = '';
  api('/api/po-number/suggest').then(({ next }) => { if (next) document.getElementById('po-number').value = next; }).catch(() => {});
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  setupHeader();
  setupNewItemDialog();
  setupGlassDialog();
  setupSubmit();
  addItemRow();
  addCategoryRow();
  Promise.all([loadReference(), loadCategories()]).then(() => { suggestPoNumberOnLoad(); });
});
