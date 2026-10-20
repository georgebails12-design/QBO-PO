// ASC 842 operating lease schedule for every lease in the ROU Lease Register, the
// QuickBooks balances at month end, and the journal entry that brings QuickBooks to
// the schedule. Same math as the ROU Lease Workbook 2026: beginning-of-month payments,
// interest = (opening liability - payment) x rate / 12, straight-line lease expense,
// ROU reduction = expense - interest, current liability = next 12 months of principal.
//
// Register rows are lease segments. Segment 1 carries the opening balances (as of the
// first day of start_month). A later segment is a modification (renewal / amendment):
// at its start_month the liability is remeasured at the PV of its payments, the change
// adjusts the ROU asset, and lease expense is reset to straight line over what is left.
// status: active | pending (inputs missing, e.g. no rate; nothing is recognized for it
// yet) | short_term (12 months or less: expensed as paid, listed for information only).
const P = $('Set Period').first().json;
const A = P.accounts;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const num = v => (v === undefined || v === null || v === '' ? null : Number(v));
const ym2i = s => { const [y, m] = String(s).slice(0, 7).split('-').map(Number); return y * 12 + m - 1; };
const i2ym = i => Math.floor(i / 12) + '-' + String((i % 12) + 1).padStart(2, '0');
const T = ym2i(P.period);
const NL = String.fromCharCode(10);

// ---- 1. Register ----
const issues = [];   // block posting
const flags = [];    // shown for review
const reg = $('Get Lease Register').all().map(i => i.json).filter(r => r.lease_id);
if (!reg.length) issues.push('The ROU Lease Register data table is empty.');
const byLease = {};
for (const r of reg) (byLease[r.lease_id] = byLease[r.lease_id] || []).push(r);

const parsePayments = (r) => {
  let list = r.payments;
  // JSON ([{"from":"2026-09","amount":2502.70}]) or the workbook's "2026-09: 2502.70; 2027-09: 2596.32".
  if (typeof list === 'string' && !list.trim().startsWith('[')) {
    list = list.split(';').join(NL).split(NL).map(x => x.trim()).filter(Boolean).map(x => {
      const mm = x.match(/^([0-9]{4}-[0-9]{2}) *[:=] *[$]?([0-9,.]+)$/);
      if (!mm) { issues.push(r.lease_name + ' segment ' + r.segment + ': cannot read payment "' + x + '" (use YYYY-MM: amount)'); return null; }
      return { from: mm[1], amount: Number(mm[2].replace(/,/g, '')) };
    }).filter(Boolean);
  } else if (typeof list === 'string') {
    try { list = JSON.parse(list || '[]'); } catch (e) { issues.push(r.lease_name + ' segment ' + r.segment + ': payments is not valid JSON'); list = []; }
  }
  return (list || []).map(p => ({ from: ym2i(p.from), amount: Number(p.amount) || 0 })).sort((a, b) => a.from - b.from);
};
const payAt = (seg, m) => {
  if (m < seg.start || m > seg.end) return 0;
  let amt = 0;
  for (const p of seg.payments) if (p.from <= m) amt = p.amount;
  return amt;
};

// ---- 2. Schedule per lease ----
const leases = [];
const shortTerm = [];
for (const [id, rows] of Object.entries(byLease)) {
  rows.sort((a, b) => Number(a.segment) - Number(b.segment));
  const segs = rows.map(r => ({
    row: r, n: Number(r.segment), status: String(r.status || 'active').trim().toLowerCase(),
    start: ym2i(r.start_month), end: ym2i(r.end_month), rate: num(r.annual_rate),
    payments: parsePayments(r),
  }));
  const name = rows[0].lease_name || id;
  const info = {
    id, name, rentAccountId: String(rows[0].rent_account_id || ''), rentAccount: rows[0].rent_account_name || '',
    classId: String(rows[0].class_id || ''), cashMatch: rows[0].cash_match || '',
    cashAccountIds: String(rows[0].cash_account_ids || rows[0].rent_account_id || '').split(',').map(s => s.trim()).filter(Boolean),
  };
  for (const s of segs.filter(s => s.status === 'short_term')) {
    if (T >= s.start && T <= s.end) shortTerm.push({ ...info, segment: s.n, pay: payAt(s, T), end: i2ym(s.end), source: s.row.source || '', notes: s.row.notes || '' });
  }
  const cap = segs.filter(s => s.status !== 'short_term');
  if (!cap.length) continue;
  const s1 = cap[0];
  if (s1.status !== 'active') { flags.push(name + ': first segment is ' + s1.status + ' - lease not recognized.'); continue; }
  if (s1.rate === null || num(s1.row.opening_liability) === null || num(s1.row.opening_net_rou) === null) {
    issues.push(name + ': segment 1 needs annual_rate, opening_liability and opening_net_rou.');
    continue;
  }

  let L = num(s1.row.opening_liability);
  let R = num(s1.row.opening_net_rou);
  let G = num(s1.row.opening_gross_rou);
  if (G === null) G = R;
  const months = {};
  const HORIZON = Math.max(T + 12, cap.reduce((x, s) => Math.max(x, s.end), 0) + 1);
  let pendingFrom = null;
  let pendingWhy = '';
  let k = 0;
  let seg = s1;
  let rate = s1.rate;
  let exp = num(s1.row.straight_line_expense);
  if (exp === null) {
    const total = seg.payments.length ? Array.from({ length: seg.end - seg.start + 1 }, (_, j) => payAt(seg, seg.start + j)).reduce((a, b) => a + b, 0) : 0;
    exp = (R + total - L) / (seg.end - seg.start + 1);
  }
  for (let m = s1.start; m <= HORIZON; m++) {
    let adj = 0;
    let gAdj = 0;
    const next = cap[k + 1];
    if (!pendingFrom && next && m === next.start) {
      if (next.status === 'pending' || next.rate === null) {
        pendingFrom = m;
        pendingWhy = next.status === 'pending' ? (next.row.notes || 'segment marked pending') : 'no annual_rate';
      } else {
        k += 1; seg = next; rate = seg.rate;
        let pv = 0, total = 0;
        for (let j = seg.start; j <= seg.end; j++) {
          const p = payAt(seg, j);
          pv += p / Math.pow(1 + rate / 12, j - seg.start);
          total += p;
        }
        adj = pv - L;
        const wasDone = Math.abs(L) < 0.005 && Math.abs(R) < 0.005;
        gAdj = wasDone ? pv - G : adj;   // a lease that had run off is derecognized and restarted at the PV
        R += adj; L = pv; G += gAdj;
        exp = (R + total - pv) / (seg.end - seg.start + 1);
      }
    }
    const pending = pendingFrom !== null && m >= pendingFrom;
    const live = !pending && m <= seg.end;
    const pay = live ? payAt(seg, m) : 0;
    const int = live ? (L - pay) * rate / 12 : 0;
    const e = live ? exp : 0;
    const red = e - int;
    const bom = { L, R, G };
    L = L - pay + int;
    R = R - red;
    // Fully run off with no later segment: derecognize gross and accumulated amortization.
    if (!pending && m > seg.end && !cap[k + 1] && Math.abs(L) < 0.005 && Math.abs(R) < 0.005) G = 0;
    months[m] = { bom, pay, int, exp: e, red, adj, gAdj, L, R, G, pending };
  }
  const at = m => months[m] || (m < s1.start ? { L: num(s1.row.opening_liability), R: num(s1.row.opening_net_rou), G: num(s1.row.opening_gross_rou) ?? num(s1.row.opening_net_rou), pay: 0, int: 0, exp: 0, red: 0, adj: 0, gAdj: 0 } : null);
  // Current = principal paid down over the next 12 months; a later remeasurement adds liability, it doesn't reduce this one.
  const cur = m => {
    const a = at(m);
    if (!a) return 0;
    let c = 0;
    for (let j = m + 1; j <= m + 12; j++) { const x = months[j]; if (x) c += x.pay - x.int; }
    return Math.min(a.L, c);
  };
  const t = at(T);
  const prev = at(T - 1);
  if (!t) continue;
  const lastEnd = cap.filter(s => s.status === 'active').reduce((x, s) => Math.max(x, s.end), 0);
  leases.push({
    ...info, pendingAtT: pendingFrom !== null && T >= pendingFrom, pendingFrom: pendingFrom === null ? '' : i2ym(pendingFrom), pendingWhy,
    lastEnd: i2ym(lastEnd), hasSuccessor: cap.length > 1,
    bomL: prev.L, bomR: prev.R, bomG: prev.G, pay: t.pay, int: t.int, exp: t.exp, red: t.red, adj: t.adj, gAdj: t.gAdj,
    L: t.L, R: t.R, G: t.G, cur: cur(T), prevCur: cur(T - 1), rate,
    schedule: Object.keys(months).map(Number).sort((a, b) => a - b).map(m => ({ m: i2ym(m), ...months[m], bom: undefined,
      bomL: months[m].bom.L, bomR: months[m].bom.R, bomG: months[m].bom.G, cur: cur(m) })),
    shortTermNow: segs.some(s => s.status === 'short_term' && T >= s.start && T <= s.end),
  });
  if (pendingFrom !== null && T >= pendingFrom) flags.push(name + ': modification from ' + i2ym(pendingFrom) + ' is not recognized yet (' + pendingWhy + '). Fill in the register and re-run this month.');
  if (lastEnd >= T && lastEnd <= T + 3 && pendingFrom === null && cap.length === 1) flags.push(name + ': lease ends ' + i2ym(lastEnd) + '. Add the renewal / extension to the register, or confirm move-out.');
}

// ---- 3. Schedule totals (debit-positive) ----
const sum = (k) => leases.reduce((s, l) => s + (l[k] || 0), 0);
const target = {
  rou: r2(sum('G')), accum: r2(-(sum('G') - sum('R'))),
  current: r2(-sum('cur')), noncurrent: r2(-(sum('L') - sum('cur'))),
};
const prior = {
  rou: r2(sum('bomG')), accum: r2(-(sum('bomG') - sum('bomR'))),
  current: r2(-sum('prevCur')), noncurrent: r2(-(sum('bomL') - sum('prevCur'))),
};

// ---- 4. QuickBooks month-end balances (Trial Balance, debit - credit) ----
const n0 = s => (s === undefined || s === null || s === '' ? 0 : Number(String(s).replace(/,/g, '')) || 0);
const tb = {};
const tbWalk = rows => {
  for (const r of rows || []) {
    if (r.Rows) tbWalk(r.Rows.Row);
    if (!r.ColData) continue;
    const c0 = r.ColData[0] || {};
    if (c0.id) tb[c0.id] = r2(n0(r.ColData[1] && r.ColData[1].value) - n0(r.ColData[2] && r.ColData[2].value));
  }
};
const tbRep = $('Get Trial Balance').first().json;
tbWalk(tbRep.Rows && tbRep.Rows.Row);
const qbo = {};
for (const k of Object.keys(target)) qbo[k] = tb[A[k].id] === undefined ? 0 : tb[A[k].id];
if (!Object.keys(tb).length) issues.push('The QuickBooks Trial Balance came back empty - check the QuickBooks credential.');

// ---- 5. ROU entries already in QuickBooks for this month ----
const existing = ((($('Find Existing ROU JE').first().json || {}).QueryResponse || {}).JournalEntry || [])
  .filter(j => String(j.DocNumber || '').startsWith(P.docNumber));
const alreadyPosted = existing.length > 0;
const docNumber = alreadyPosted ? P.docNumber + '-' + (existing.length + 1) : P.docNumber;

// ---- 6. Rent actually expensed in QuickBooks this month, per lease ----
const gl = {};
const glWalk = (rows, acctId) => {
  for (const r of rows || []) {
    if (r.Header) {
      const h = (r.Header.ColData || [])[0] || {};
      glWalk(r.Rows && r.Rows.Row, h.id || acctId);
      continue;
    }
    if (r.Rows) { glWalk(r.Rows.Row, acctId); continue; }
    const c = (r.ColData || []).map(x => x.value);
    if (!c.length || !acctId || c[0] === 'Beginning Balance' || /^Total/.test(c[0] || '')) continue;
    const amount = n0(c[6]);
    if (!amount) continue;
    if (/^ROU-/.test(c[2] || '')) continue;  // this workflow's own entries
    (gl[acctId] = gl[acctId] || []).push({ date: c[0], type: c[1], doc: c[2], name: c[3] || '', memo: c[4] || '', amount });
  }
};
const glRep = $('Get Rent GL').first().json;
glWalk(glRep.Rows && glRep.Rows.Row, '');
const cashFor = l => {
  if (!l.cashMatch) return null;
  let re;
  try { re = new RegExp(l.cashMatch, 'i'); } catch (e) { return null; }
  let s = 0;
  for (const a of l.cashAccountIds) for (const g of gl[a] || []) if (re.test(g.name + ' ' + g.memo)) s += g.amount;
  return r2(s);
};
for (const l of leases.concat(shortTerm)) {
  if (l.schedule && l.shortTermNow && !l.pay) { l.cashQbo = null; continue; }  // rent checked on the short-term row
  l.cashQbo = cashFor(l);
  if (l.cashQbo !== null && Math.abs(l.cashQbo - r2(l.pay)) >= 0.01)
    flags.push(l.name + ': rent expensed in QuickBooks this month ' + l.cashQbo.toFixed(2) + ' vs ' + r2(l.pay).toFixed(2) + ' per lease (timing, CAM/tax, or a missed payment).');
}

// ---- 7. Journal entry ----
const lines = [];
const memo = (s) => String(s).slice(0, 4000);
const line = (amount, acctId, acctName, desc, classId) => {
  const a = r2(amount);
  if (Math.abs(a) < 0.01) return;
  const d = { PostingType: a > 0 ? 'Debit' : 'Credit', AccountRef: { value: acctId, name: acctName } };
  if (classId) d.ClassRef = { value: classId };
  lines.push({ DetailType: 'JournalEntryLineDetail', Amount: Math.abs(a), Description: memo(desc), JournalEntryLineDetail: d });
};
const delta = {};
for (const k of Object.keys(target)) delta[k] = r2(target[k] - qbo[k]);
let offsets = 0;
if (!alreadyPosted) {
  for (const l of leases) {
    if (l.pendingAtT) continue;
    const off = r2(l.exp - l.pay);
    if (Math.abs(off) < 0.01) continue;
    if (!l.rentAccountId) { issues.push(l.name + ': no rent_account_id in the register.'); continue; }
    line(off, l.rentAccountId, l.rentAccount, l.name + ' - straight-line lease expense ' + r2(l.exp).toFixed(2) + ' less rent paid ' + r2(l.pay).toFixed(2) + ' - ' + P.label, l.classId);
    offsets = r2(offsets + off);
  }
}
const lbl = { rou: 'ROU asset' + (sum('adj') ? ' (incl. remeasurement)' : ''), accum: 'ROU amortization', current: 'current lease liability', noncurrent: 'noncurrent lease liability' };
for (const k of Object.keys(target)) line(delta[k], A[k].id, A[k].name, 'ROU leases ' + P.label + ' - ' + lbl[k] + ' to schedule', '');
const residual = r2(-(Object.values(delta).reduce((a, b) => a + b, 0) + offsets));
line(residual, A.tieOut.id, A.tieOut.name, 'ROU leases ' + P.label + ' - tie-out of QuickBooks to the lease schedule (prior differences / entries made outside this workflow)', '');
const debits = r2(lines.filter(x => x.JournalEntryLineDetail.PostingType === 'Debit').reduce((s, x) => s + x.Amount, 0));
const credits = r2(lines.filter(x => x.JournalEntryLineDetail.PostingType === 'Credit').reduce((s, x) => s + x.Amount, 0));
if (debits !== credits) issues.push('Entry does not balance: debits ' + debits + ', credits ' + credits + '.');
const openDiff = {};
for (const k of Object.keys(target)) openDiff[k] = r2(qbo[k] - prior[k]);
const derecognized = Math.abs(openDiff.rou) >= 1 && Math.abs(openDiff.rou + openDiff.accum) < 1;
if (!alreadyPosted && derecognized)
  flags.push(A.rou.name + ' and ' + A.accum.name + ' both still carry ' + openDiff.rou.toFixed(2) + ' for lease(s) that have fully run off; this entry removes it from both (no P&L effect).');
for (const k of Object.keys(target)) if (!alreadyPosted && Math.abs(openDiff[k]) >= 1 && !(derecognized && (k === 'rou' || k === 'accum')))
  flags.push(A[k].name + ': QuickBooks before this entry is ' + openDiff[k].toFixed(2) + ' away from the schedule at the end of last month - the difference is in the tie-out line.');
if (Math.abs(residual) >= 50) flags.push('Tie-out line to ' + A.tieOut.name + ' is ' + residual.toFixed(2) + ' - review before approving.');

// ---- 8. Email ----
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = n => (n === null || n === undefined || n === '') ? '' : ((n < 0 ? '-' : '') + '$' + Math.abs(r2(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const th = 'style="padding:4px 8px;background:#1F3864;color:#fff;text-align:left"';
const td = 'style="padding:4px 8px;border-bottom:1px solid #ddd"';
const tdr = 'style="padding:4px 8px;border-bottom:1px solid #ddd;text-align:right"';
const table = (head, rows) => '<table style="border-collapse:collapse;font-size:13px"><tr>' + head.map(h => '<th ' + th + '>' + h + '</th>').join('') + '</tr>' +
  rows.map(r => '<tr>' + r.map(c => typeof c === 'number' ? '<td ' + tdr + '>' + money(c) + '</td>' : '<td ' + td + '>' + esc(c) + '</td>').join('') + '</tr>').join('') + '</table>';

const intro = '<p>ROU lease month-end for <b>' + esc(P.label) + '</b>. Proposed QuickBooks journal entry <b>' + esc(docNumber) + '</b> dated ' + P.end + '.' +
  (alreadyPosted ? ' <b>' + existing.length + ' ROU entry already posted for this month</b> (' + existing.map(j => j.DocNumber + ' id ' + j.Id).join(', ') + '); only the remaining difference is proposed.' : '') + '</p>';
const issuesHtml = issues.length ? '<p style="color:#C00000"><b>Cannot post:</b><br>' + issues.map(esc).join('<br>') + '</p>' : '';
const jeHtml = '<h3>Proposed entry</h3>' + (lines.length
  ? table(['Account', 'Debit', 'Credit', 'Memo'], lines.map(x => [x.JournalEntryLineDetail.AccountRef.name,
      x.JournalEntryLineDetail.PostingType === 'Debit' ? x.Amount : '', x.JournalEntryLineDetail.PostingType === 'Credit' ? x.Amount : '', x.Description]).concat([['Total', debits, credits, '']]))
  : '<p>Nothing to post - QuickBooks already agrees with the schedule.</p>');
const balHtml = '<h3>Balances at ' + P.end + ' (debit +, credit -)</h3>' + table(['Account', 'Schedule last month', 'QuickBooks now', 'This entry', 'QuickBooks after', 'Schedule'],
  Object.keys(target).map(k => [A[k].name, prior[k], qbo[k], delta[k], r2(qbo[k] + delta[k]), target[k]]));
const leasesHtml = '<h3>Leases</h3>' + table(['Lease', 'Rate', 'Liability BOM', 'Rent paid', 'Interest', 'Remeasure', 'Liability EOM', 'Current', 'Net ROU BOM', 'Amortization', 'Net ROU EOM', 'Lease expense', 'Rent in QBO', 'Note'],
  leases.map(l => [l.name, l.rate === null ? '' : (l.rate * 100).toFixed(2) + '%', l.bomL, l.pay, l.int, l.adj, l.L, l.cur, l.bomR, l.red, l.R, l.exp, l.cashQbo === null ? '' : l.cashQbo,
    l.pendingAtT ? 'PENDING from ' + l.pendingFrom : (l.adj ? 'Remeasured this month' : '')]).concat([['Total', '', sum('bomL'), sum('pay'), sum('int'), sum('adj'), sum('L'), sum('cur'), sum('bomR'), sum('red'), sum('R'), sum('exp'), '', '']]));
const stHtml = shortTerm.length ? '<h3>Short-term leases (expensed as paid, no ROU)</h3>' + table(['Lease', 'Rent per lease', 'Rent in QBO', 'Term ends', 'Note'],
  shortTerm.map(s => [s.name, s.pay, s.cashQbo === null ? '' : s.cashQbo, s.end, s.notes])) : '';
const flagsHtml = flags.length ? '<h3>Review</h3><ul>' + flags.map(f => '<li>' + esc(f) + '</li>').join('') + '</ul>' : '';
const foot = '<p style="color:#595959;font-size:12px">Schedule from the ROU Lease Register data table (operating leases, risk-free rate election, beginning-of-month payments). ' +
  'The attached ROU_Rollforward_' + P.period + '.xlsx has the roll-forward, YTD by month, every lease schedule and the Register sheet: edit the Register sheet and upload the file on the ROU Lease Register Upload form to change a lease. Sent by n8n.</p>';
const wrap = x => '<div style="font-family:Segoe UI,Arial;font-size:13px">' + x + '</div>';
const html = wrap(intro + issuesHtml + jeHtml + balHtml + leasesHtml + stHtml + flagsHtml + foot);
const approvalHtml = wrap(intro + issuesHtml + jeHtml + balHtml + flagsHtml +
  '<p>Approve posts this entry to QuickBooks exactly as shown; Decline posts nothing. The full report and the roll-forward workbook (ROU_Rollforward_' + P.period + '.xlsx) are in the email sent just before this one.</p>');

const canPost = !issues.length && lines.length > 0;
const subject = (issues.length ? '[CANNOT POST] ' : '') + 'ROU leases ' + P.label + ' - ' + (lines.length ? 'approve JE ' + docNumber + ' (' + money(debits) + ')' : 'nothing to post') +
  (flags.length ? ' - ' + flags.length + ' to review' : '');
return [{ json: {
  period: P.period, label: P.label, end: P.end, docNumber, alreadyPosted, canPost,
  needsApproval: canPost && P.sendForApproval, debits, credits, issues, flags, subject, html, approvalHtml,
  target, qbo, delta, prior, residual,
  shortTerm: shortTerm.map(s => ({ name: s.name, pay: s.pay, cashQbo: s.cashQbo, end: s.end, notes: s.notes })),
  schedules: leases.map(l => ({ name: l.name, rate: l.rate, pendingFrom: l.pendingFrom, rows: l.schedule.map(x => ({
    m: x.m, pay: r2(x.pay), bomL: r2(x.bomL), adj: r2(x.adj), int: r2(x.int), L: r2(x.L), cur: r2(x.cur), bomG: r2(x.bomG), G: r2(x.G),
    bomR: r2(x.bomR), red: r2(x.red), R: r2(x.R), exp: r2(x.exp), pending: !!x.pending })) })),
  leases: leases.map(l => ({ name: l.name, rate: l.rate, bomL: r2(l.bomL), bomR: r2(l.bomR), bomG: r2(l.bomG), pay: r2(l.pay), int: r2(l.int), exp: r2(l.exp), red: r2(l.red), adj: r2(l.adj), L: r2(l.L), R: r2(l.R), G: r2(l.G), cur: r2(l.cur), pending: l.pendingAtT, cashQbo: l.cashQbo })),
  payload: lines.length ? { TxnDate: P.end, DocNumber: docNumber,
    PrivateNote: 'ROU operating lease month-end for ' + P.label + ' (ASC 842) - generated by the n8n ROU Lease Month-End workflow, approved by email.', Line: lines } : null,
} }];
