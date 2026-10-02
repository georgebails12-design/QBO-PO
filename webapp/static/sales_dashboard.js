// Sales Dashboard page: monthly sales and cash collected from QuickBooks, sliced by RSM and month.
// The server sends pre-aggregated facts ({m: month, r: RSM, sales, n, cash}); every filter is applied here.

let data = null;
const state = { rsm: '', period: '' };   // rsm: '' = all; period: '' = all, 'Y:2026' = a year, '2026-08' = one month
const INVOICE_ROW_LIMIT = 50;
let showAllInvoices = false;

function api(path, opts) {
  return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts))
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.open('/login', '_blank');
        throw new Error('Your login expired. Log in again in the new tab, then retry here.');
      }
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      return body;
    });
}

function el(tag, attrs, text) {
  const e = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v));
  if (text !== undefined) e.textContent = text;
  return e;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(m, long) {
  const [y, mo] = m.split('-');
  return long ? `${MONTHS[+mo - 1]} ${y}` : `${MONTHS[+mo - 1]} '${y.slice(2)}`;
}
function money(v) {
  return (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US');
}
function moneyShort(v) {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}K` : `${Math.round(a)}`;
  return (v < 0 ? '-$' : '$') + s;
}

function inPeriod(m, period) {
  if (!period) return true;
  if (period.startsWith('Y:')) return m.startsWith(period.slice(2));
  return m === period;
}
function periodLabel(period) {
  if (!period) return `${monthLabel(data.months[0], true)} – ${monthLabel(data.months[data.months.length - 1], true)}`;
  if (period.startsWith('Y:')) return period.slice(2);
  return monthLabel(period, true);
}
function facts(filter) {
  return data.facts.filter((f) => (!state.rsm || f.r === state.rsm) && (!filter || filter(f)));
}
function sum(rows) {
  return rows.reduce((t, f) => ({ sales: t.sales + f.sales, cash: t.cash + f.cash, n: t.n + f.n }), { sales: 0, cash: 0, n: 0 });
}

// ---------------------------------------------------------------------------
// Slicers
// ---------------------------------------------------------------------------
function fillSlicers() {
  const rsmSel = document.getElementById('sd-rsm');
  rsmSel.innerHTML = '';
  rsmSel.appendChild(el('option', { value: '' }, 'All RSMs'));
  data.rsms.forEach((r) => rsmSel.appendChild(el('option', { value: r }, r)));
  rsmSel.value = data.rsms.includes(state.rsm) ? state.rsm : '';
  state.rsm = rsmSel.value;

  const monthSel = document.getElementById('sd-month');
  monthSel.innerHTML = '';
  monthSel.appendChild(el('option', { value: '' }, 'All months'));
  const years = [...new Set(data.months.map((m) => m.slice(0, 4)))].reverse();
  const yGroup = el('optgroup', { label: 'Year' });
  years.forEach((y) => yGroup.appendChild(el('option', { value: `Y:${y}` }, `${y} (full year)`)));
  monthSel.appendChild(yGroup);
  const mGroup = el('optgroup', { label: 'Month' });
  [...data.months].reverse().forEach((m) => mGroup.appendChild(el('option', { value: m }, monthLabel(m, true))));
  monthSel.appendChild(mGroup);
  const valid = !state.period || data.months.includes(state.period) || years.includes(state.period.slice(2));
  monthSel.value = valid ? state.period : '';
  state.period = monthSel.value;
}

function setRsm(rsm) {
  showAllInvoices = false;
  state.rsm = state.rsm === rsm ? '' : rsm;
  document.getElementById('sd-rsm').value = state.rsm;
  render();
}
function setPeriod(period) {
  showAllInvoices = false;
  state.period = state.period === period ? '' : period;
  document.getElementById('sd-month').value = state.period;
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  if (!data) return;
  const who = state.rsm || 'All RSMs';
  const when = periodLabel(state.period);
  const cur = sum(facts((f) => inPeriod(f.m, state.period)));

  document.getElementById('sd-kpi-sales').textContent = money(cur.sales);
  document.getElementById('sd-kpi-cash').textContent = money(cur.cash);
  document.getElementById('sd-kpi-count').textContent = cur.n.toLocaleString('en-US');
  document.getElementById('sd-kpi-ratio').textContent = cur.sales > 0 ? `${Math.round((cur.cash / cur.sales) * 100)}%` : '–';
  const sub = `${who} · ${when}`;
  ['sd-kpi-sales-sub', 'sd-kpi-cash-sub', 'sd-kpi-count-sub'].forEach((id) => { document.getElementById(id).textContent = sub; });

  renderChart(who);
  renderRsmTable(when);
  renderMonthTable(who);
  renderInvoices(who, when);
}

function chartMonths() {
  // A year (or all months) shows that range; a single month shows the full history with it highlighted.
  if (state.period.startsWith('Y:')) return data.months.filter((m) => inPeriod(m, state.period));
  return data.months;
}

function renderChart(who) {
  const months = chartMonths();
  const byMonth = {};
  months.forEach((m) => { byMonth[m] = { sales: 0, cash: 0, n: 0 }; });
  facts((f) => byMonth[f.m]).forEach((f) => {
    byMonth[f.m].sales += f.sales; byMonth[f.m].cash += f.cash; byMonth[f.m].n += f.n;
  });
  document.getElementById('sd-chart-title').textContent = `By month · ${who}`;

  const W = 1060, H = 300, padL = 56, padR = 8, padT = 12, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const vals = months.flatMap((m) => [byMonth[m].sales, byMonth[m].cash]);
  const maxV = Math.max(1, ...vals), minV = Math.min(0, ...vals);
  const step = niceStep((maxV - minV) / 4);
  const top = Math.ceil(maxV / step) * step, bottom = Math.floor(minV / step) * step;
  const y = (v) => padT + plotH - ((v - bottom) / (top - bottom)) * plotH;
  const slot = plotW / months.length;
  const barW = Math.max(3, Math.min(22, (slot - 10) / 2));
  const gap = 2;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Sales and cash collected by month for ${who}`);
  const add = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (text !== undefined) e.textContent = text;
    svg.appendChild(e);
    return e;
  };

  for (let v = bottom; v <= top + step / 2; v += step) {
    add('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: v === 0 ? 'baseline' : 'grid-line' });
    add('text', { x: padL - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis-label' }, moneyShort(v));
  }
  const labelEvery = Math.ceil(months.length / 14);
  const selIdx = months.indexOf(state.period);
  // Thinned labels, plus the selected month's; drop regular labels that would crowd it.
  const showLabel = (i) => i === selIdx || (i % labelEvery === 0 && (selIdx < 0 || Math.abs(i - selIdx) >= Math.max(2, labelEvery)));
  const tooltip = document.getElementById('sd-tooltip');

  months.forEach((m, i) => {
    const cx = padL + slot * i + slot / 2;
    const d = byMonth[m];
    const selected = state.period === m;
    const hit = add('rect', {
      x: padL + slot * i, y: padT, width: slot, height: plotH, class: `month-hit${selected ? ' selected' : ''}`,
      tabindex: 0, role: 'button', 'aria-label': `${monthLabel(m, true)}: sales ${money(d.sales)}, cash ${money(d.cash)}`,
    });
    drawBar(add, cx - gap / 2 - barW, barW, y(Math.max(0, d.sales)), y(Math.min(0, d.sales)), d.sales >= 0, 'bar-sales');
    drawBar(add, cx + gap / 2, barW, y(Math.max(0, d.cash)), y(Math.min(0, d.cash)), d.cash >= 0, 'bar-cash');
    if (showLabel(i)) {
      add('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: `axis-label month-label${selected ? ' selected' : ''}` }, monthLabel(m));
    }
    const show = (evt) => {
      tooltip.innerHTML = '';
      tooltip.appendChild(el('div', { class: 'tt-title' }, `${monthLabel(m, true)} · ${who}`));
      [['Sales', d.sales, 'var(--series-sales)'], ['Cash collected', d.cash, 'var(--series-cash)']].forEach(([name, v, color]) => {
        const row = el('div', { class: 'tt-row' });
        const key = el('i', { class: 'tt-key' });
        key.style.background = color;
        row.append(key, el('b', {}, money(v)), el('span', {}, name));
        tooltip.appendChild(row);
      });
      tooltip.appendChild(el('div', { class: 'tt-row' }, `${d.n} invoice${d.n === 1 ? '' : 's'} · click to ${selected ? 'clear' : 'select'} month`));
      tooltip.hidden = false;
      const r = evt.target.getBoundingClientRect();
      const x = evt.clientX !== undefined && evt.type !== 'focus' ? evt.clientX : r.left + r.width / 2;
      tooltip.style.left = `${Math.min(window.innerWidth - tooltip.offsetWidth - 8, x + 14)}px`;
      tooltip.style.top = `${Math.max(8, r.top + 10)}px`;
    };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', () => { tooltip.hidden = true; });
    hit.addEventListener('blur', () => { tooltip.hidden = true; });
    hit.addEventListener('click', () => { tooltip.hidden = true; setPeriod(m); });
    hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPeriod(m); } });
  });

  const wrap = document.getElementById('sd-chart');
  wrap.innerHTML = '';
  wrap.appendChild(svg);
}

// A bar with 4px rounded corners on its data end only (top for positive values, bottom for negative).
function drawBar(add, x, w, yTop, yBottom, positive, cls) {
  const h = Math.max(0, yBottom - yTop);
  if (h < 0.5) return;
  const r = Math.min(4, h, w / 2);
  const d = positive
    ? `M${x},${yBottom} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + w - r} Q${x + w},${yTop} ${x + w},${yTop + r} V${yBottom} Z`
    : `M${x},${yTop} V${yBottom - r} Q${x},${yBottom} ${x + r},${yBottom} H${x + w - r} Q${x + w},${yBottom} ${x + w},${yBottom - r} V${yTop} Z`;
  add('path', { d, class: cls });
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function renderRsmTable(when) {
  document.getElementById('sd-rsm-title').textContent = `By RSM · ${when}`;
  const rows = {};
  data.facts.filter((f) => inPeriod(f.m, state.period)).forEach((f) => {
    const r = rows[f.r] = rows[f.r] || { sales: 0, cash: 0, n: 0 };
    r.sales += f.sales; r.cash += f.cash; r.n += f.n;
  });
  const list = Object.entries(rows).filter(([, v]) => v.sales || v.cash || v.n).sort((a, b) => b[1].sales - a[1].sales);
  const maxV = Math.max(1, ...list.flatMap(([, v]) => [v.sales, v.cash]));
  const tbody = document.getElementById('sd-rsm-body');
  tbody.innerHTML = '';
  const total = { sales: 0, cash: 0, n: 0 };
  list.forEach(([name, v]) => {
    total.sales += v.sales; total.cash += v.cash; total.n += v.n;
    const tr = el('tr', { class: `clickable${state.rsm === name ? ' active' : ''}`, tabindex: 0 });
    tr.append(el('td', {}, name), el('td', { class: 'num' }, v.n.toLocaleString('en-US')),
      el('td', { class: 'num' }, money(v.sales)), el('td', { class: 'num' }, money(v.cash)));
    const barCell = el('td', { class: 'sd-bar-cell' });
    const bars = el('div', { class: 'sd-minibar' });
    [['s', v.sales], ['c', v.cash]].forEach(([c, val]) => {
      const b = el('i', { class: c });
      b.style.width = `${Math.max(0, (val / maxV) * 100)}%`;
      bars.appendChild(b);
    });
    barCell.appendChild(bars);
    tr.appendChild(barCell);
    tr.addEventListener('click', () => setRsm(name));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') setRsm(name); });
    tbody.appendChild(tr);
  });
  const tfoot = tbody.parentElement.querySelector('tfoot') || tbody.parentElement.appendChild(el('tfoot'));
  tfoot.innerHTML = '';
  const tr = el('tr');
  tr.append(el('td', {}, 'Total'), el('td', { class: 'num' }, total.n.toLocaleString('en-US')),
    el('td', { class: 'num' }, money(total.sales)), el('td', { class: 'num' }, money(total.cash)), el('td', { class: 'sd-bar-cell' }));
  tfoot.appendChild(tr);
}

function renderMonthTable(who) {
  const months = chartMonths();
  document.getElementById('sd-month-title').textContent = `Month by month · ${who}`;
  const byMonth = {};
  facts().forEach((f) => {
    const r = byMonth[f.m] = byMonth[f.m] || { sales: 0, cash: 0, n: 0 };
    r.sales += f.sales; r.cash += f.cash; r.n += f.n;
  });
  const tbody = document.getElementById('sd-month-body');
  tbody.innerHTML = '';
  const total = { sales: 0, cash: 0, n: 0 };
  [...months].reverse().forEach((m) => {
    const v = byMonth[m] || { sales: 0, cash: 0, n: 0 };
    total.sales += v.sales; total.cash += v.cash; total.n += v.n;
    const diff = v.cash - v.sales;
    const tr = el('tr', { class: `clickable${state.period === m ? ' active' : ''}`, tabindex: 0 });
    tr.append(el('td', {}, monthLabel(m, true)), el('td', { class: 'num' }, v.n.toLocaleString('en-US')),
      el('td', { class: 'num' }, money(v.sales)), el('td', { class: 'num' }, money(v.cash)),
      el('td', { class: `num${diff < 0 ? ' neg' : ''}` }, money(diff)));
    tr.addEventListener('click', () => setPeriod(m));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') setPeriod(m); });
    tbody.appendChild(tr);
  });
  const tfoot = tbody.parentElement.querySelector('tfoot') || tbody.parentElement.appendChild(el('tfoot'));
  tfoot.innerHTML = '';
  const tr = el('tr');
  const diff = total.cash - total.sales;
  tr.append(el('td', {}, 'Total'), el('td', { class: 'num' }, total.n.toLocaleString('en-US')),
    el('td', { class: 'num' }, money(total.sales)), el('td', { class: 'num' }, money(total.cash)),
    el('td', { class: `num${diff < 0 ? ' neg' : ''}` }, money(diff)));
  tfoot.appendChild(tr);
}

function renderInvoices(who, when) {
  document.getElementById('sd-inv-title').textContent = `Invoices · ${who} · ${when}`;
  const list = data.invoices
    .filter((v) => (!state.rsm || v.rsm === state.rsm) && inPeriod(v.date.slice(0, 7), state.period))
    .sort((a, b) => b.date.localeCompare(a.date) || b.sales - a.sales);
  const tbody = document.getElementById('sd-inv-body');
  tbody.innerHTML = '';
  list.slice(0, showAllInvoices ? list.length : INVOICE_ROW_LIMIT).forEach((v) => {
    const tr = el('tr');
    tr.append(el('td', {}, v.doc || v.id), el('td', {}, v.date), el('td', {}, v.customer), el('td', {}, v.rsm),
      el('td', { class: 'num' }, money(v.sales)), el('td', { class: 'num' }, money(v.total)),
      el('td', { class: 'num' }, money(v.balance)));
    tbody.appendChild(tr);
  });
  const truncated = !showAllInvoices && list.length > INVOICE_ROW_LIMIT;
  document.getElementById('sd-inv-hint').textContent = truncated
    ? `Showing the ${INVOICE_ROW_LIMIT} most recent of ${list.length.toLocaleString('en-US')} invoices. Pick a month or RSM to narrow it down.`
    : `${list.length.toLocaleString('en-US')} invoice${list.length === 1 ? '' : 's'}. "Sales" is the part of each invoice that is revenue (deposits and sales tax excluded).`;
  document.getElementById('sd-inv-more').hidden = !truncated;
}

// ---------------------------------------------------------------------------
// Loading / refreshing
// ---------------------------------------------------------------------------
function showData(d) {
  data = d;
  document.getElementById('sd-as-of').textContent = d.built_at
    ? `As of ${new Date(d.built_at * 1000).toLocaleString()}` : '';
  document.getElementById('sd-footnote').textContent = d.notes || '';
  fillSlicers();
  render();
}

function load() {
  const status = document.getElementById('sd-status');
  const body = document.getElementById('sd-body');
  body.classList.add('loading');
  return api('/api/sales-dashboard')
    .then((d) => {
      body.classList.remove('loading');
      if (!d.facts) {
        status.textContent = 'No sales data yet -- loading it from QuickBooks (takes about a minute)...';
        refresh();
        return;
      }
      status.textContent = '';
      showData(d);
    })
    .catch((e) => { body.classList.remove('loading'); status.textContent = e.message; });
}

function refresh() {
  const status = document.getElementById('sd-status');
  const btn = document.getElementById('sd-refresh-btn');
  btn.disabled = true;
  status.textContent = 'Pulling invoices and payments from QuickBooks (takes about a minute)...';
  document.getElementById('sd-body').classList.add('loading');
  api('/api/sales-dashboard/refresh', { method: 'POST' })
    .then(({ job_id }) => new Promise((resolve, reject) => {
      const poll = () => api(`/api/sales-dashboard/refresh/${job_id}`).then((job) => {
        if (job.status === 'running') setTimeout(poll, 3000);
        else if (job.status === 'error') reject(new Error(job.error));
        else resolve();
      }).catch(reject);
      poll();
    }))
    .then(() => { status.textContent = ''; return load(); })
    .catch((e) => { status.textContent = `Refresh failed: ${e.message}`; document.getElementById('sd-body').classList.remove('loading'); })
    .finally(() => { btn.disabled = false; });
}

document.getElementById('sd-rsm').addEventListener('change', (e) => { state.rsm = e.target.value; showAllInvoices = false; render(); });
document.getElementById('sd-month').addEventListener('change', (e) => { state.period = e.target.value; showAllInvoices = false; render(); });
document.getElementById('sd-refresh-btn').addEventListener('click', refresh);
document.getElementById('sd-inv-more').addEventListener('click', () => { showAllInvoices = true; render(); });
load();
