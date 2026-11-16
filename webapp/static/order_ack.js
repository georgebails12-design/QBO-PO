// Glass Acknowledgement page: check a Cardinal order acknowledgement against its PO, then save the cost and date.
const $ = (id) => document.getElementById(id);
const money = (n) => (n == null ? '' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const rate = (n) => (n == null ? '' : Number(n).toFixed(4));
const RED = 'color:var(--danger, #b3432f)';
let last = null; // {id, expected, date_field, plan}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function send(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.open('/login', '_blank');
    throw new Error('Your login expired. Log in again in the new tab, then retry here.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function setStatus(text, isError) {
  const el = $('ack-status');
  el.textContent = text;
  el.style.cssText = isError ? RED : '';
}

const DATE_LABEL = { due: 'Due date', txn: 'PO date', none: 'Date' };

function renderPo(po, result) {
  const issues = po.lines.filter((l) => l.status !== 'ok').length;
  let status = po.problems.length ? `<span style="${RED}">${escapeHtml(po.problems.join(' '))}</span>`
    : po.unchanged ? 'Already up to date' : 'Ready';
  if (result) {
    status = result.result === 'updated' ? 'Updated'
      : result.result === 'unchanged' ? 'Already up to date'
      : result.result === 'check' ? `<span style="${RED}">Saved, but QuickBooks shows $${money(result.total)}</span>`
      : `<span style="${RED}">${result.result === 'skipped' ? 'Skipped' : 'Failed'}: ${escapeHtml(result.error)}</span>`;
    if (result.attached) status += ` &middot; PDF ${result.attached === 'already attached' ? 'already attached' : 'attached'}`;
    if (result.error && result.result !== 'failed' && result.result !== 'skipped') status += ` <span style="${RED}">(${escapeHtml(result.error)})</span>`;
  }
  const rows = po.lines.map((l) => {
    const flags = l.flags.length ? `<div style="${RED}">${l.flags.map(escapeHtml).join('<br>')}</div>` : '';
    if (l.status === 'missing') {
      return `<tr><td>${l.po_line}</td><td>${escapeHtml(l.size)}</td><td>${l.qty}</td><td></td>
        <td class="amount-cell">${rate(l.unit_price)}</td><td class="amount-cell">${money(l.ext)}</td>
        <td><b style="${RED}">Not on the PO</b>${flags}</td></tr>`;
    }
    const qty = l.po_qty === l.qty ? l.qty : `<span style="${RED}">${l.qty} (PO ${l.po_qty})</span>`;
    return `<tr><td>${l.po_line}</td><td>${escapeHtml(l.size)}</td><td>${qty}</td>
      <td class="amount-cell">${rate(l.old_rate)}</td><td class="amount-cell">${rate(l.new_rate)}</td>
      <td class="amount-cell">${money(l.new_amount)}</td><td>${escapeHtml(l.po_item)}${flags}</td></tr>`;
  }).join('');
  const notAcked = po.not_acknowledged.length
    ? `<p class="hint"><b>On the PO but not on this acknowledgement</b> (left as they are):<br>${po.not_acknowledged
      .map((n) => `Line ${n.po_line}: ${escapeHtml(n.item)}, qty ${n.qty}, $${money(n.amount)}`).join('<br>')}</p>` : '';
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-title-row">
      <h2>PO ${escapeHtml(po.po_number)} &middot; ${escapeHtml(po.vendor || '')} &middot; $${money(po.old_total)} -> $${money(po.new_total)}</h2>
    </div>
    <p>${DATE_LABEL[po.date_field]}: ${po.old_date || '-'} -> ${po.new_date || '(unchanged)'}${po.expected_field ? ` (also in ${escapeHtml(po.expected_field)})` : ''}
      &middot; Acknowledged $${money(po.ack_total)} on SO ${escapeHtml(po.sales_orders)}
      &middot; ${issues ? `<b style="${RED}">${issues} line(s) to check</b>` : 'All sizes and quantities match'}
      &middot; Status: ${status}</p>
    <p class="hint">Memo: ${escapeHtml(po.note)}</p>
    <table class="grid">
      <thead><tr><th>Line</th><th>Cardinal size</th><th>Qty</th><th class="amount-cell">Rate now</th>
        <th class="amount-cell">Cardinal rate</th><th class="amount-cell">Amount</th><th>PO item</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>${notAcked}`;
  return card;
}

function render(plan, results) {
  const ack = plan.ack;
  $('ack-flags').innerHTML = ack.flags.map((f) => `<li style="${RED}">${escapeHtml(f)}</li>`).join('');
  const byPo = {};
  (results || []).forEach((r) => { byPo[r.po_number] = r; });
  const wrap = $('ack-pos');
  wrap.innerHTML = '';
  plan.pos.forEach((po) => wrap.appendChild(renderPo(po, byPo[po.po_number])));
  const canApply = !results && plan.pos.some((po) => !po.problems.length && !po.unchanged);
  const attach = $('ack-attach').checked && !results && plan.pos.some((po) => !po.problems.length);
  if (canApply || attach) {
    const bar = document.createElement('div');
    bar.className = 'card';
    bar.innerHTML = '<button type="button" class="btn-primary" id="ack-apply-btn">Update PO</button>';
    wrap.appendChild(bar);
    $('ack-apply-btn').addEventListener('click', applyChanges);
  }
}

$('ack-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData($('ack-form'));
  setStatus('Reading the acknowledgement and looking up the PO...');
  $('ack-pos').innerHTML = '';
  $('ack-flags').innerHTML = '';
  try {
    const data = await send('/api/order-ack/preview', { method: 'POST', body: fd });
    last = { id: data.id, expected: data.expected, date_field: fd.get('date_field'), plan: data.plan };
    const a = data.plan.ack;
    setStatus(`Acknowledgement ${a.date || ''}, SO ${a.sales_orders.join(', ')}, requested ${a.requested_date || '?'}: `
      + `${a.line_count} lines, $${money(a.total)}. Check the sizes, then click Update PO.`);
    render(data.plan);
  } catch (err) {
    setStatus(err.message, true);
  }
});

async function applyChanges() {
  if (!last) return;
  const issues = last.plan.pos.reduce((n, po) => n + po.lines.filter((l) => l.status !== 'ok').length, 0);
  const msg = `Update PO ${last.plan.ack.po_numbers.join(', ')} in QuickBooks with Cardinal's cost and date?`
    + (issues ? `\n\n${issues} line(s) still need checking -- lines not on the PO won't be updated.` : '');
  if (!confirm(msg)) return;
  $('ack-apply-btn').disabled = true;
  setStatus('Updating the PO...');
  try {
    const data = await send('/api/order-ack/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: last.id, date_field: last.date_field, expected: last.expected, attach: $('ack-attach').checked }),
    });
    render(data.plan, data.results);
    const bad = data.results.filter((r) => r.error || r.result === 'check');
    setStatus(bad.length ? 'Something needs a look -- see Status on the PO.' : 'Done. The PO has Cardinal\'s cost and date.', bad.length > 0);
  } catch (err) {
    setStatus(err.message, true);
    $('ack-apply-btn').disabled = false;
  }
}
