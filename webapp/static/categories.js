// Manage Categories page logic.

let qboCategories = [];
let accounts = [];
let mappedCategories = {};
let editingCategory = null;

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

function renderTable() {
  const names = new Set([...Object.keys(mappedCategories), ...qboCategories.map((c) => c.name)]);
  const sorted = [...names].sort();
  const tbody = document.getElementById('categories-table-body');
  tbody.innerHTML = '';
  sorted.forEach((name) => {
    const mapping = mappedCategories[name];
    const tr = document.createElement('tr');
    const expenseName = mapping ? mapping.expense_account.name : '(not mapped)';
    const incomeName = mapping ? mapping.income_account.name : '(not mapped)';
    tr.innerHTML = `<td>${escapeHtml(name)}</td><td>${escapeHtml(expenseName)}</td><td>${escapeHtml(incomeName)}</td>
      <td><button type="button" class="btn-secondary map-btn">Map / Edit...</button></td>`;
    tr.querySelector('.map-btn').addEventListener('click', () => openMapDialog(name, mapping));
    tbody.appendChild(tr);
  });
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function loadAll() {
  return Promise.all([
    api('/api/categories').then((c) => { mappedCategories = c; }),
    api('/api/categories/qbo').then((c) => { qboCategories = c; }),
  ]).then(renderTable);
}

function openMapDialog(name, mapping) {
  editingCategory = name;
  document.getElementById('map-category-title').textContent = `Map "${name}"`;
  document.getElementById('map-error').style.display = 'none';

  function populate() {
    const expenseSel = document.getElementById('map-expense');
    const incomeSel = document.getElementById('map-income');
    const opts = accounts
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => `<option value="${a.id}">${escapeHtml(a.name)} (${escapeHtml(a.account_type || '')})</option>`)
      .join('');
    expenseSel.innerHTML = opts;
    incomeSel.innerHTML = opts;
    if (mapping) {
      expenseSel.value = mapping.expense_account.id;
      incomeSel.value = mapping.income_account.id;
    }
    document.getElementById('map-category-dialog').showModal();
  }

  if (accounts.length) { populate(); return; }
  api('/api/accounts').then((a) => { accounts = a; populate(); }).catch((e) => alert(e.message));
}

document.addEventListener('DOMContentLoaded', () => {
  loadAll();
  document.getElementById('refresh-categories').addEventListener('click', loadAll);
  document.getElementById('map-cancel').addEventListener('click', () => document.getElementById('map-category-dialog').close());
  document.getElementById('map-save').addEventListener('click', () => {
    const expenseSel = document.getElementById('map-expense');
    const incomeSel = document.getElementById('map-income');
    const errEl = document.getElementById('map-error');
    if (!expenseSel.value || !incomeSel.value) {
      errEl.textContent = 'Choose both accounts.'; errEl.style.display = 'block'; return;
    }
    const expenseAcc = accounts.find((a) => a.id === expenseSel.value);
    const incomeAcc = accounts.find((a) => a.id === incomeSel.value);
    api('/api/categories', {
      method: 'POST',
      body: JSON.stringify({
        name: editingCategory,
        expense_account: { id: expenseAcc.id, name: expenseAcc.name },
        income_account: { id: incomeAcc.id, name: incomeAcc.name },
      }),
    }).then((cats) => {
      mappedCategories = cats;
      renderTable();
      document.getElementById('map-category-dialog').close();
    }).catch((e) => { errEl.textContent = e.message; errEl.style.display = 'block'; });
  });
});
