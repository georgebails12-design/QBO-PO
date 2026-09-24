// Helpers shared by the Purchase Order and PO Requests pages.

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
function customerFilter(c, term) { return c.name.toLowerCase().includes(term); }

function itemLabel(it) {
  const price = it.purchase_cost != null ? it.purchase_cost : it.unit_price;
  const priceStr = typeof price === 'number' ? price.toFixed(2) : '--';
  const desc = (it.description || '').trim();
  return (desc ? `${it.name} — ${desc}` : it.name) + `  ($${priceStr})`;
}

function escapeHtml(s) {
  return (s || '').toString().replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
