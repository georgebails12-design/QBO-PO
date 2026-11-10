// Adjust Bills page: preview and save bills re-priced to the dollars paid.
const $ = (id) => document.getElementById(id);
const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let lastPlan = null;
let lastBody = null;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function call(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.open('/login', '_blank');
    throw new Error('Your login expired. Log in again in the new tab, then retry here.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function setStatus(text, isError) {
  const el = $('adjust-status');
  el.textContent = text;
  el.style.color = isError ? 'var(--danger, #b3432f)' : '';
}

function formBody() {
  const fd = new FormData($('adjust-form'));
  return Object.fromEntries(fd.entries());
}

function render(plan, results) {
  lastPlan = plan;
  $('adjust-result-card').style.display = '';
  const diff = plan.new_total - plan.old_total;
  $('adjust-title').textContent = `${plan.vendor.name}: ${plan.bills.length} bills, $${money(plan.old_total)} -> `
    + `$${money(plan.new_total)} (${diff >= 0 ? '+' : ''}${money(diff)}), rate ${plan.rate}`;
  const byDoc = {};
  (results || []).forEach((r) => { byDoc[r.doc] = r; });
  const rows = plan.bills.map((b) => {
    const r = byDoc[b.doc];
    let status = b.unchanged ? 'Already this amount' : 'Ready';
    if (r) {
      status = r.result === 'updated' ? 'Updated'
        : r.result === 'unchanged' ? 'Already this amount'
        : r.result === 'check' ? `<span style="color:#b3432f">Saved, but QuickBooks shows $${money(r.total)}</span>`
        : `<span style="color:#b3432f">Failed: ${escapeHtml(r.error)}</span>`;
    }
    const lines = b.lines.length > 1 || plan.mode === 'line'
      ? b.lines.map((l) => `<tr class="hint"><td></td><td colspan="2">${escapeHtml(l.description)}</td>
          <td class="amount-cell">${money(l.old)}</td><td class="amount-cell">${money(l.new)}</td><td></td><td></td></tr>`).join('')
      : '';
    return `<tr><td>${escapeHtml(b.doc)}</td><td>${b.date}</td><td>${b.due || ''}</td>
      <td class="amount-cell">${money(b.old)}</td><td class="amount-cell">${money(b.new)}</td>
      <td class="amount-cell">${money(b.diff)}</td><td>${status}</td></tr>${lines}`;
  }).join('');
  $('adjust-body').innerHTML = rows + `<tr><td><b>Total</b></td><td></td><td></td>
    <td class="amount-cell"><b>${money(plan.old_total)}</b></td><td class="amount-cell"><b>${money(plan.new_total)}</b></td>
    <td class="amount-cell"><b>${money(diff)}</b></td><td></td></tr>`;
  $('adjust-apply-btn').disabled = !!results || plan.bills.every((b) => b.unchanged);
}

$('adjust-mode').addEventListener('change', (e) => {
  $('adjust-account-field').style.display = e.target.value === 'line' ? '' : 'none';
});

$('adjust-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  lastBody = formBody();
  setStatus('Looking up the bills...');
  $('adjust-result-card').style.display = 'none';
  try {
    render(await call('/api/bill-adjust/preview', lastBody));
    setStatus('Check the new amounts, then click Update bills.');
  } catch (err) {
    setStatus(err.message, true);
  }
});

$('adjust-apply-btn').addEventListener('click', async () => {
  if (!lastPlan || !lastBody) return;
  if (!confirm(`Change ${lastPlan.bills.length} ${lastPlan.vendor.name} bills in QuickBooks to total $${money(lastPlan.new_total)}?`)) return;
  const expected = Object.fromEntries(lastPlan.bills.map((b) => [b.doc, b.new]));
  $('adjust-apply-btn').disabled = true;
  setStatus('Updating bills...');
  try {
    const data = await call('/api/bill-adjust/apply', { ...lastBody, expected });
    render(data.plan, data.results);
    const bad = data.results.filter((r) => r.result === 'failed' || r.result === 'check');
    setStatus(bad.length ? `${bad.length} bill(s) need a look -- see Status.` : 'Done. The bills now total the amount paid.', bad.length > 0);
  } catch (err) {
    setStatus(err.message, true);
    $('adjust-apply-btn').disabled = false;
  }
});
