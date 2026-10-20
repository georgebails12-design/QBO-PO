import { workflow, node, trigger, ifElse, sticky, expr } from '@n8n/workflow-sdk';

const runNow = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Now', position: [0, 0] }, output: [{}] });

const monthly = trigger({
  type: 'n8n-nodes-base.scheduleTrigger', version: 1.4,
  config: { name: '5th of Month 7am', position: [0, 200], parameters: { rule: { interval: [{ field: 'months', monthsInterval: 1, triggerAtDayOfMonth: 5, triggerAtHour: 7, triggerAtMinute: 0 }] } } },
  output: [{}]
});

const calledByUpload = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger', version: 1.2,
  config: { name: 'Called by Register Upload', position: [0, 400], parameters: { inputSource: 'workflowInputs', workflowInputs: { values: [{ name: 'month', type: 'string' }] } } },
  output: [{ month: '2026-09' }]
});

const setPeriod = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Set Period', position: [240, 100], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `// Month to close. Default: the previous calendar month (the schedule runs on the 5th,
// after the prepaid rent amortization on the 3rd). To run or re-run a month, set
// MONTH_OVERRIDE = 'YYYY-MM'. Months must be closed in order: each month's entry trues
// QuickBooks up to the schedule, so a skipped month lands in the next month's tie-out line.
const MONTH_OVERRIDE = '';
// true  = email the proposed entry with Approve / Decline buttons; Approve posts it.
// false = report only: email the proposal, never post.
const SEND_FOR_APPROVAL = true;
const APPROVER = 'George@Panda-Windows.com';
// Days the approval link stays open. After that the run ends and nothing is posted.
const APPROVAL_DAYS = 14;

// QuickBooks accounts (ids from the chart of accounts).
const ACCOUNTS = {
  rou: { id: '1157', name: '2000 Rights of Use Assets' },
  accum: { id: '1158', name: '2001 ROU Asset Amortization' },
  current: { id: '1160', name: '2320 Lease Liability - Current' },
  noncurrent: { id: '1159', name: '2600 Lease Liability - Noncurrent' },
  // Differences between QuickBooks and the schedule that are not this month's
  // activity (entries booked outside this workflow, skipped months) go here.
  tieOut: { id: '788', name: '6280 Rent' },
};

// A month passed in by the ROU Lease Register Upload workflow (re-run after a register change) wins.
const passed = String(($input.first().json || {}).month || '').trim();
const month = /^[0-9]{4}-[0-9]{2}$/.test(passed) ? passed : MONTH_OVERRIDE;
const tz = 'America/Los_Angeles';
const m = month
  ? DateTime.fromISO(month + '-01', { zone: tz })
  : $now.setZone(tz).minus({ months: 1 }).startOf('month');
return [{ json: {
  period: m.toFormat('yyyy-MM'),
  start: m.toFormat('yyyy-MM-dd'),
  end: m.endOf('month').toFormat('yyyy-MM-dd'),
  label: m.toFormat('MMM yyyy'),
  docNumber: 'ROU-' + m.toFormat('yyyyMM'),
  sendForApproval: SEND_FOR_APPROVAL,
  approver: APPROVER,
  approvalDays: APPROVAL_DAYS,
  accounts: ACCOUNTS,
  runAt: $now.setZone(tz).toFormat('yyyy-MM-dd HH:mm'),
} }];
` } },
  output: [{ period: '2026-09', start: '2026-09-01', end: '2026-09-30', label: 'Sep 2026', docNumber: 'ROU-202609', sendForApproval: true, approver: 'George@Panda-Windows.com', approvalDays: 14, accounts: {}, runAt: '2026-10-05 07:00' }]
});

const getRegister = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: {
    name: 'Get Lease Register', position: [480, 100], executeOnce: true,
    parameters: { resource: 'row', operation: 'get', dataTableId: { __rl: true, mode: 'id', value: 'sek8aEvAaYqqtY9W', cachedResultName: 'ROU Lease Register' }, returnAll: true }
  },
  output: [{ lease_id: 'ENTD', lease_name: 'ENTD LLC (Panda 2)', segment: 1, status: 'active' }]
});

const getTb = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {
    name: 'Get Trial Balance', position: [720, 100], executeOnce: true,
    parameters: {
      url: 'https://quickbooks.api.intuit.com/v3/company/9341454547526446/reports/TrialBalance', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true, queryParameters: { parameters: [{ name: 'start_date', value: expr("{{ $('Set Period').first().json.start }}") }, { name: 'end_date', value: expr("{{ $('Set Period').first().json.end }}") }, { name: 'accounting_method', value: 'Accrual' }, { name: 'minorversion', value: '75' }] },
      sendHeaders: true, headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] }, options: { timeout: 60000 }
    },
    credentials: { quickBooksOAuth2Api: { id: 'sFWFYsCNN6o8AYZG', name: 'QuickBooks Online account' } }
  },
  output: [{ Rows: { Row: [] } }]
});

const getGl = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {
    name: 'Get Rent GL', position: [960, 100], executeOnce: true,
    parameters: {
      url: 'https://quickbooks.api.intuit.com/v3/company/9341454547526446/reports/GeneralLedger', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true, queryParameters: { parameters: [{ name: 'account', value: expr("{{ [...new Set($('Get Lease Register').all().flatMap(i => String((i.json.rent_account_id || '') + ',' + (i.json.cash_account_ids || '')).split(',')).map(s => s.trim()).filter(Boolean))].join(',') }}") }, { name: 'start_date', value: expr("{{ $('Set Period').first().json.start }}") }, { name: 'end_date', value: expr("{{ $('Set Period').first().json.end }}") }, { name: 'accounting_method', value: 'Accrual' }, { name: 'columns', value: 'tx_date,txn_type,doc_num,name,memo,split_acc,subt_nat_amount' }, { name: 'minorversion', value: '75' }] },
      sendHeaders: true, headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] }, options: { timeout: 60000 }
    },
    credentials: { quickBooksOAuth2Api: { id: 'sFWFYsCNN6o8AYZG', name: 'QuickBooks Online account' } }
  },
  output: [{ Rows: { Row: [] } }]
});

const findJe = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {
    name: 'Find Existing ROU JE', position: [1200, 100], executeOnce: true,
    parameters: {
      url: 'https://quickbooks.api.intuit.com/v3/company/9341454547526446/query', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true, queryParameters: { parameters: [{ name: 'query', value: expr("{{ `select * from JournalEntry where TxnDate = '${$('Set Period').first().json.end}' MAXRESULTS 1000` }}") }, { name: 'minorversion', value: '75' }] },
      sendHeaders: true, headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] }, options: { timeout: 60000 }
    },
    credentials: { quickBooksOAuth2Api: { id: 'sFWFYsCNN6o8AYZG', name: 'QuickBooks Online account' } }
  },
  output: [{ Rows: { Row: [] } }]
});

const buildProposal = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Build Proposal', position: [1440, 100], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `// ASC 842 operating lease schedule for every lease in the ROU Lease Register, the
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
` } },
  output: [{ period: '2026-09', label: 'Sep 2026', docNumber: 'ROU-202609', needsApproval: true, canPost: true, subject: 'ROU leases Sep 2026', html: '<p></p>', debits: 0, issues: [], flags: [], qbo: {}, payload: {} }]
});

const buildWorkbook = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Build Workbook', position: [1680, 100], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `// Monthly ROU roll-forward workbook (ROU_Rollforward_YYYY-MM.xlsx), attached to the
// proposal email. Sheets: Summary (balances, JE, review items), Rollforward (this month
// by lease), YTD Rollforward (each month of the year, all leases), Schedules (every
// lease month by month to the end of its term), Register (the ROU Lease Register; edit
// it and upload the file on the ROU Lease Register Upload form), Instructions.
// n8n has no Excel library in Code nodes, so the .xlsx is written directly (zlib only).
const zlib = require('zlib');
const p = $('Build Proposal').first().json;
const P = $('Set Period').first().json;
const reg = $('Get Lease Register').all().map(i => i.json).filter(r => r.lease_id);
const A = P.accounts;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

// ---------- cells: number | string | { v, s } with s in title, h (header), b (bold), m (money), bm (bold money), pct ----------
const S = { title: 1, h: 2, b: 3, m: 4, bm: 5, pct: 6, wrap: 7 };
const sheets = [];
const sheet = (name, widths) => { const sh = { name, widths, rows: [] }; sheets.push(sh); return sh; };
const M = v => (v === '' || v === null || v === undefined ? '' : { v: r2(v), s: 'm' });
const BM = v => ({ v: r2(v), s: 'bm' });
const B = v => ({ v, s: 'b' });
const H = list => list.map(v => ({ v, s: 'h' }));

// ---------- Summary ----------
const status = p.issues.length ? 'CANNOT POST: ' + p.issues.join('; ')
  : !p.payload ? 'Nothing to post - QuickBooks agrees with the schedule'
  : P.sendForApproval ? 'Proposed - awaiting email approval (JE ' + p.docNumber + ')' : 'Report only - not sent for approval';
const sum = sheet('Summary', [34, 18, 18, 18, 18, 18, 60]);
sum.rows.push([{ v: 'Panda Holdings LLC - ROU lease roll-forward (ASC 842)', s: 'title' }]);
sum.rows.push(['Period', p.label + ' (' + p.end + ')']);
sum.rows.push(['Journal entry', p.docNumber + ' - ' + status]);
sum.rows.push(['Prepared', P.runAt + ' by the n8n ROU Lease Month-End workflow']);
sum.rows.push([]);
sum.rows.push([B('Balances (debit +, credit -)')]);
sum.rows.push(H(['Account', 'Schedule last month', 'QuickBooks before JE', 'This JE', 'QuickBooks after JE', 'Schedule this month', 'Difference after JE']));
for (const k of Object.keys(p.target)) {
  const after = r2(p.qbo[k] + p.delta[k]);
  sum.rows.push([A[k].name, M(p.prior[k]), M(p.qbo[k]), M(p.delta[k]), M(after), M(p.target[k]), M(r2(after - p.target[k]))]);
}
const lt = () => r2(p.target.current + p.target.noncurrent);
sum.rows.push([B('Net ROU asset'), BM(p.prior.rou + p.prior.accum), BM(p.qbo.rou + p.qbo.accum), BM(p.delta.rou + p.delta.accum), BM(p.qbo.rou + p.qbo.accum + p.delta.rou + p.delta.accum), BM(p.target.rou + p.target.accum), '']);
sum.rows.push([B('Total lease liability'), BM(p.prior.current + p.prior.noncurrent), BM(p.qbo.current + p.qbo.noncurrent), BM(p.delta.current + p.delta.noncurrent), BM(p.qbo.current + p.qbo.noncurrent + p.delta.current + p.delta.noncurrent), BM(lt()), '']);
sum.rows.push([]);
sum.rows.push([B('Journal entry ' + p.docNumber + ' dated ' + p.end)]);
sum.rows.push(H(['Account', 'Debit', 'Credit', '', '', '', 'Memo']));
for (const l of (p.payload || {}).Line || []) {
  const d = l.JournalEntryLineDetail;
  sum.rows.push([d.AccountRef.name, d.PostingType === 'Debit' ? M(l.Amount) : '', d.PostingType === 'Credit' ? M(l.Amount) : '', '', '', '', l.Description]);
}
sum.rows.push([B('Total'), BM(p.debits), BM(p.credits)]);
sum.rows.push([]);
if (p.issues.length || p.flags.length) {
  sum.rows.push([B('Review items')]);
  for (const x of p.issues) sum.rows.push(['CANNOT POST', { v: x, s: 'wrap' }]);
  for (const x of p.flags) sum.rows.push(['Review', { v: x, s: 'wrap' }]);
}

// ---------- Rollforward (this month, by lease) ----------
const rf = sheet('Rollforward', [28, 9, 16, 15, 14, 14, 16, 16, 16, 16, 16, 16, 16, 16, 16, 15, 15, 22]);
rf.rows.push([{ v: 'ROU roll-forward - ' + p.label, s: 'title' }]);
rf.rows.push(H(['Lease', 'Rate', 'Liability BOM', 'Remeasurement', 'Payments', 'Interest', 'Liability EOM', 'Current', 'Noncurrent',
  'Gross ROU BOM', 'Accum. amort. BOM', 'Net ROU BOM', 'Remeasurement', 'Amortization', 'Net ROU EOM', 'Lease expense', 'Rent in QBO', 'Status']));
const totals = {};
for (const l of p.leases) {
  const row = { bomL: l.bomL, adjL: l.adj, pay: l.pay, int: l.int, L: l.L, cur: l.cur, non: r2(l.L - l.cur), bomG: l.bomG, bomA: r2(l.bomR - l.bomG), bomR: l.bomR, adjR: l.adj, red: l.red, R: l.R, exp: l.exp };
  for (const [k, v] of Object.entries(row)) totals[k] = r2((totals[k] || 0) + v);
  rf.rows.push([l.name, l.rate === null ? '' : { v: l.rate, s: 'pct' }, M(row.bomL), M(row.adjL), M(-row.pay), M(row.int), M(row.L), M(row.cur), M(row.non),
    M(row.bomG), M(row.bomA), M(row.bomR), M(row.adjR), M(-row.red), M(row.R), M(row.exp), l.cashQbo === null ? '' : M(l.cashQbo), l.pending ? 'Modification pending' : (l.adj ? 'Remeasured' : '')]);
}
rf.rows.push([B('Total'), '', BM(totals.bomL), BM(totals.adjL), BM(-totals.pay), BM(totals.int), BM(totals.L), BM(totals.cur), BM(totals.non),
  BM(totals.bomG), BM(totals.bomA), BM(totals.bomR), BM(totals.adjR), BM(-totals.red), BM(totals.R), BM(totals.exp)]);
rf.rows.push([]);
rf.rows.push(['Check: liability BOM + remeasurement - payments + interest - EOM', '', M(r2(totals.bomL + totals.adjL - totals.pay + totals.int - totals.L))]);
rf.rows.push(['Check: net ROU BOM + remeasurement - amortization - EOM', '', M(r2(totals.bomR + totals.adjR - totals.red - totals.R))]);
if (p.shortTerm && p.shortTerm.length) {
  rf.rows.push([]);
  rf.rows.push([B('Short-term leases (expensed as paid, no ROU)')]);
  rf.rows.push(H(['Lease', '', 'Rent per lease', 'Rent in QBO', 'Term ends', 'Note']));
  for (const s of p.shortTerm) rf.rows.push([s.name, '', M(s.pay), s.cashQbo === null ? '' : M(s.cashQbo), s.end, s.notes]);
}

// ---------- YTD Rollforward (each month of the calendar year, all leases) ----------
const year = p.period.slice(0, 4);
const months = [];
for (let i = 1; i <= Number(p.period.slice(5, 7)); i++) months.push(year + '-' + String(i).padStart(2, '0'));
const agg = {};
for (const sc of p.schedules) for (const x of sc.rows) {
  if (!months.includes(x.m)) continue;
  const a = agg[x.m] = agg[x.m] || { bomL: 0, adj: 0, pay: 0, int: 0, L: 0, cur: 0, bomR: 0, red: 0, R: 0, exp: 0, G: 0 };
  for (const k of Object.keys(a)) a[k] = r2(a[k] + (x[k] || 0));
}
const ytd = sheet('YTD Rollforward', [30].concat(months.map(() => 15)).concat([16]));
ytd.rows.push([{ v: 'ROU monthly roll-forward ' + year + ' - all leases (schedule)', s: 'title' }]);
ytd.rows.push(H(['Month end'].concat(months).concat(['YTD'])));
const line = (label, f, flow, bold) => {
  const vals = months.map(m => f(agg[m] || {}));
  const total = flow ? r2(vals.reduce((s, v) => s + v, 0)) : '';
  ytd.rows.push([bold ? B(label) : label].concat(vals.map(v => bold ? BM(v) : M(v))).concat([total === '' ? '' : (bold ? BM(total) : M(total))]));
};
ytd.rows.push([B('Lease liability')]);
line('Beginning liability', a => a.bomL || 0);
line('Remeasurement / additions', a => a.adj || 0, true);
line('Payments', a => -(a.pay || 0), true);
line('Interest accretion', a => a.int || 0, true);
line('Ending liability', a => a.L || 0, false, true);
line('  Current', a => a.cur || 0);
line('  Noncurrent', a => r2((a.L || 0) - (a.cur || 0)));
ytd.rows.push([B('ROU asset')]);
line('Beginning net ROU', a => a.bomR || 0);
line('Remeasurement / additions', a => a.adj || 0, true);
line('Amortization (ROU reduction)', a => -(a.red || 0), true);
line('Ending net ROU', a => a.R || 0, false, true);
line('  Gross ROU', a => a.G || 0);
line('  Accumulated amortization', a => r2((a.R || 0) - (a.G || 0)));
ytd.rows.push([B('P&L')]);
line('Straight-line lease expense', a => a.exp || 0, true);
line('  of which interest accretion', a => a.int || 0, true);
line('  of which ROU amortization', a => a.red || 0, true);

// ---------- Schedules (every lease, every month) ----------
const sch = sheet('Schedules', [28, 10, 15, 16, 14, 14, 16, 16, 16, 16, 16, 15, 16, 16, 15, 12]);
sch.rows.push([{ v: 'Lease schedules (beginning-of-month payments; interest = (opening liability - payment) x rate / 12)', s: 'title' }]);
sch.rows.push(H(['Lease', 'Month', 'Payment', 'Liability BOM', 'Remeasurement', 'Interest', 'Liability EOM', 'Current', 'Noncurrent', 'Net ROU BOM',
  'Amortization', 'Net ROU EOM', 'Gross ROU', 'Accum. amort.', 'Lease expense', 'Note']));
for (const sc of p.schedules) for (const x of sc.rows) {
  if (x.m < year + '-01') continue;
  if (!x.pay && !x.bomL && !x.L && !x.R && !x.adj && !x.pending) continue;
  sch.rows.push([sc.name, x.m, M(x.pay), M(x.bomL), M(x.adj), M(x.int), M(x.L), M(x.cur), M(r2(x.L - x.cur)), M(x.bomR), M(x.red), M(x.R), M(x.G), M(r2(x.R - x.G)), M(x.exp),
    x.pending ? 'pending' : (x.m === p.period ? '<- this month' : '')]);
}

// ---------- Register (round-trip: edit and upload) ----------
const COLS = ['lease_id', 'lease_name', 'segment', 'status', 'start_month', 'end_month', 'annual_rate', 'payments', 'opening_liability', 'opening_net_rou',
  'opening_gross_rou', 'straight_line_expense', 'rent_account_id', 'rent_account_name', 'class_id', 'cash_account_ids', 'cash_match', 'source', 'notes'];
const payText = v => {
  let list = v;
  if (typeof v === 'string' && v.trim().startsWith('[')) { try { list = JSON.parse(v); } catch (e) { return v; } }
  if (!Array.isArray(list)) return v == null ? '' : String(v);
  return list.map(x => x.from + ': ' + Number(x.amount).toFixed(2)).join('; ');
};
const rg = sheet('Register', [12, 28, 9, 11, 12, 11, 11, 44, 16, 16, 16, 14, 11, 28, 10, 14, 26, 50, 60]);
rg.rows.push(H(COLS));
const sorted = reg.slice().sort((a, b) => String(a.lease_id).localeCompare(String(b.lease_id)) || Number(a.segment) - Number(b.segment));
for (const r of sorted) rg.rows.push(COLS.map(c => {
  const v = r[c];
  if (c === 'payments') return payText(v);
  if (v === null || v === undefined) return '';
  return typeof v === 'number' ? v : String(v);
}));

// ---------- Instructions ----------
const ins = sheet('Instructions', [110]);
[
  { v: 'How to update leases', s: 'title' },
  'The Register sheet is the lease register the workflow uses. One row per lease segment: segment 1 is the original lease with its opening balances; 2, 3... are renewals / amendments in date order.',
  'New amendment or renewal: add a row with the same lease_id, the next segment number, status active, start_month = month it takes effect (YYYY-MM), end_month = last month of the new term, annual_rate (e.g. 0.0415) and payments.',
  'New lease: add a row with a new lease_id, segment 1, status active, opening_liability = opening_net_rou = opening_gross_rou = PV of the payments at start_month, straight_line_expense blank (computed).',
  'Short-term lease (12 months or less, short-term election): status short_term. It is listed but not capitalized.',
  'Inputs not final yet: status pending. The lease is flagged every month and nothing is recognized for that segment.',
  'payments: rent steps as "YYYY-MM: amount; YYYY-MM: amount", e.g. "2026-09: 2502.70; 2027-09: 2596.32; 2028-09: 2674.21". Payments are at the beginning of each month.',
  'Then upload this file on the "ROU Lease Register Upload" form (n8n). You get an email listing every change with Approve / Decline; Approve replaces the register and, if you entered a month, re-runs that month.',
  'Do not rename the Register sheet or its column headers. Other sheets are ignored on upload.',
].forEach(t => ins.rows.push([typeof t === 'string' ? { v: t, s: 'wrap' } : t]));

// ---------- xlsx writer ----------
const C = String.fromCharCode;
const CTRL = new RegExp('[' + C(0) + '-' + C(8) + C(11) + C(12) + C(14) + '-' + C(31) + ']', 'g');
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(CTRL, '');
const colName = i => { let s = ''; i += 1; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const sheetXml = sh => {
  let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
  if (sh.name !== 'Instructions' && sh.name !== 'Summary') x += '<sheetViews><sheetView workbookViewId="0"><pane ySplit="' + (sh.name === 'Register' ? 1 : 2) + '" topLeftCell="A' + (sh.name === 'Register' ? 2 : 3) + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  x += '<cols>' + sh.widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols><sheetData>';
  sh.rows.forEach((row, ri) => {
    x += '<row r="' + (ri + 1) + '">';
    row.forEach((c, ci) => {
      if (c === '' || c === null || c === undefined) return;
      const cell = typeof c === 'object' ? c : { v: c };
      const ref = colName(ci) + (ri + 1);
      const st = cell.s ? ' s="' + S[cell.s] + '"' : '';
      if (typeof cell.v === 'number' && isFinite(cell.v)) x += '<c r="' + ref + '"' + st + '><v>' + cell.v + '</v></c>';
      else x += '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(cell.v) + '</t></is></c>';
    });
    x += '</row>';
  });
  return x + '</sheetData></worksheet>';
};
const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00;(#,##0.00);&quot;-&quot;"/><numFmt numFmtId="165" formatCode="0.00%"/></numFmts>' +
  '<fonts count="4"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font><font><b/><sz val="13"/><color rgb="FF1F3864"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/></patternFill></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8">' +
  [[0, 0, 0, 0, ''], [0, 2, 0, 0, ''], [0, 3, 2, 0, '<alignment wrapText="1" vertical="center"/>'], [0, 1, 0, 0, ''], [164, 0, 0, 0, ''], [164, 1, 0, 1, ''], [165, 0, 0, 0, ''],
    [0, 0, 0, 0, '<alignment wrapText="1" vertical="top"/>']].map(([n, f, fi, b, al]) => '<xf numFmtId="' + n + '" fontId="' + f + '" fillId="' + fi + '" borderId="' + b + '" xfId="0"' +
    (n ? ' applyNumberFormat="1"' : '') + (f ? ' applyFont="1"' : '') + (fi ? ' applyFill="1"' : '') + (b ? ' applyBorder="1"' : '') + (al ? ' applyAlignment="1">' + al + '</xf>' : '/>')).join('') +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
const files = [
  ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>'],
  ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
  ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets.map((s, i) => '<sheet name="' + xmlEsc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
    '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
  ['xl/styles.xml', styles],
].concat(sheets.map((s, i) => ['xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s)]));

const crcTable = [];
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
const crc32 = buf => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const locals = [];
const central = [];
let offset = 0;
for (const [name, text] of files) {
  const raw = Buffer.from(text, 'utf8');
  const comp = zlib.deflateRawSync(raw);
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(raw);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
  locals.push(lh, nameBuf, comp);
  central.push(ch, nameBuf);
  offset += 30 + nameBuf.length + comp.length;
}
const cdSize = central.reduce((s, b) => s + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
const xlsx = Buffer.concat(locals.concat(central).concat([end]));

const fileName = 'ROU_Rollforward_' + p.period + '.xlsx';
return [{ json: { fileName, bytes: xlsx.length, sheets: sheets.map(s => s.name) },
  binary: { workbook: { data: xlsx.toString('base64'), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName, fileExtension: 'xlsx' } } }];
` } },
  output: [{ fileName: 'ROU_Rollforward_2026-09.xlsx', bytes: 0, sheets: [] }]
});

const emailWorkbook = node({
  type: 'n8n-nodes-base.microsoftOutlook', version: 2,
  config: {
    name: 'Email Report and Workbook', position: [1920, 100], onError: 'continueRegularOutput',
    parameters: { resource: 'message', operation: 'send', toRecipients: expr("{{ $('Set Period').first().json.approver }}"),
      subject: expr("{{ $('Build Proposal').first().json.subject }}"), bodyContent: expr("{{ $('Build Proposal').first().json.html }}"),
      additionalFields: { bodyContentType: 'html', attachments: { attachments: [{ binaryPropertyName: 'workbook' }] } } },
    credentials: { microsoftOutlookOAuth2Api: { id: 'MLhN5eoDaYrrb4sO', name: 'Microsoft Outlook account' } }
  },
  output: [{ success: true }]
});

const ifSend = ifElse({
  version: 2.2,
  config: { name: 'Send For Approval?', position: [2160, 100], parameters: { conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
    conditions: [{ leftValue: expr("{{ $('Build Proposal').first().json.needsApproval }}"), operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and' } } }
});

const askApproval = node({
  type: 'n8n-nodes-base.microsoftOutlook', version: 2,
  config: {
    name: 'Email for Approval', position: [2400, 0],
    parameters: {
      resource: 'message', operation: 'sendAndWait',
      toRecipients: expr("{{ $('Set Period').first().json.approver }}"),
      subject: expr("{{ 'Approve: ' + $('Build Proposal').first().json.subject }}"),
      message: expr("{{ $('Build Proposal').first().json.approvalHtml }}"),
      responseType: 'approval',
      approvalOptions: { values: { approvalType: 'double', approveLabel: 'Approve and post', buttonApprovalStyle: 'primary', disapproveLabel: 'Decline', buttonDisapprovalStyle: 'secondary' } },
      options: { limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: expr("{{ $('Set Period').first().json.approvalDays }}"), resumeUnit: 'days' } }, appendAttribution: false }
    },
    credentials: { microsoftOutlookOAuth2Api: { id: 'MLhN5eoDaYrrb4sO', name: 'Microsoft Outlook account' } }
  },
  output: [{ data: { approved: true } }]
});

const ifApproved = ifElse({
  version: 2.2,
  config: { name: 'Approved?', position: [2640, 0], parameters: { conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
    conditions: [{ leftValue: expr("{{ $json.data?.approved === true }}"), operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and' } } }
});

const recheckJe = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {
    name: 'Recheck Existing ROU JE', position: [2880, -100], executeOnce: true,
    parameters: {
      url: 'https://quickbooks.api.intuit.com/v3/company/9341454547526446/query', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true, queryParameters: { parameters: [{ name: 'query', value: expr("{{ `select * from JournalEntry where TxnDate = '${$('Set Period').first().json.end}' MAXRESULTS 1000` }}") }, { name: 'minorversion', value: '75' }] },
      sendHeaders: true, headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] }, options: { timeout: 60000 }
    },
    credentials: { quickBooksOAuth2Api: { id: 'sFWFYsCNN6o8AYZG', name: 'QuickBooks Online account' } }
  },
  output: [{ Rows: { Row: [] } }]
});

const recheckTb = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {
    name: 'Recheck Balances', position: [3120, -100], executeOnce: true,
    parameters: {
      url: 'https://quickbooks.api.intuit.com/v3/company/9341454547526446/reports/TrialBalance', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true, queryParameters: { parameters: [{ name: 'start_date', value: expr("{{ $('Set Period').first().json.start }}") }, { name: 'end_date', value: expr("{{ $('Set Period').first().json.end }}") }, { name: 'accounting_method', value: 'Accrual' }, { name: 'minorversion', value: '75' }] },
      sendHeaders: true, headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] }, options: { timeout: 60000 }
    },
    credentials: { quickBooksOAuth2Api: { id: 'sFWFYsCNN6o8AYZG', name: 'QuickBooks Online account' } }
  },
  output: [{ Rows: { Row: [] } }]
});

const guard = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Guard Before Posting', position: [3360, -100], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `// Runs after Approve. Posts only if nothing changed since the proposal was emailed:
// no ROU entry with this DocNumber exists yet, and the four ROU / lease liability
// balances in QuickBooks are still what the proposal was built on.
const p = $('Build Proposal').first().json;
const P = $('Set Period').first().json;
const A = P.accounts;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const n0 = s => (s === undefined || s === null || s === '' ? 0 : Number(String(s).replace(/,/g, '')) || 0);
const dup = ((($('Recheck Existing ROU JE').first().json || {}).QueryResponse || {}).JournalEntry || [])
  .filter(j => j.DocNumber === p.docNumber);
const tb = {};
const walk = rows => {
  for (const r of rows || []) {
    if (r.Rows) walk(r.Rows.Row);
    const c0 = ((r.ColData || [])[0]) || {};
    if (c0.id) tb[c0.id] = r2(n0(r.ColData[1] && r.ColData[1].value) - n0(r.ColData[2] && r.ColData[2].value));
  }
};
const rep = $('Recheck Balances').first().json;
walk(rep.Rows && rep.Rows.Row);
const moved = Object.keys(p.qbo).filter(k => Math.abs((tb[A[k].id] || 0) - p.qbo[k]) >= 0.01)
  .map(k => A[k].name + ' was ' + p.qbo[k].toFixed(2) + ', now ' + (tb[A[k].id] || 0).toFixed(2));
const why = dup.length ? 'journal entry ' + p.docNumber + ' already exists in QuickBooks (id ' + dup.map(j => j.Id).join(', ') + ')'
  : moved.length ? 'QuickBooks ROU / lease liability balances changed after the proposal was sent (' + moved.join('; ') + ')' : '';
if (!why) return [{ json: { clear: true, payload: p.payload } }];
const html = '<div style="font-family:Segoe UI,Arial;font-size:13px"><p><b>Not posted.</b> ROU entry ' + p.docNumber + ' for ' + p.label +
  ' was approved, but ' + why + '. Run the month again (MONTH_OVERRIDE = "' + p.period + '") for a fresh proposal.</p></div>';
return [{ json: { clear: false, subject: '[NOT POSTED] ROU leases ' + p.label + ' - ' + p.docNumber, html,
  log: { period: p.period, doc_number: p.docNumber, status: 'blocked', amount: p.debits, qbo_je_id: '', detail: why,
    run_at: P.runAt, execution_id: String($execution.id) } } }];
` } },
  output: [{ clear: true, payload: {} }]
});

const ifClear = ifElse({
  version: 2.2,
  config: { name: 'Clear To Post?', position: [3600, -100], parameters: { conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
    conditions: [{ leftValue: expr("{{ $json.clear }}"), operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and' } } }
});

const postJe = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {
    name: 'Post Journal Entry', position: [3840, -200], onError: 'continueRegularOutput',
    parameters: {
      method: 'POST', url: 'https://quickbooks.api.intuit.com/v3/company/9341454547526446/journalentry', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true, queryParameters: { parameters: [{ name: 'minorversion', value: '75' }] },
      sendHeaders: true, headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] },
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: expr('{{ JSON.stringify($json.payload) }}'),
      options: { timeout: 60000, response: { response: { neverError: true } } }
    },
    credentials: { quickBooksOAuth2Api: { id: 'sFWFYsCNN6o8AYZG', name: 'QuickBooks Online account' } }
  },
  output: [{ JournalEntry: { Id: '1' } }]
});

const posted = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Posted Result', position: [4080, -200], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `// Result of posting the approved entry.
const p = $('Build Proposal').first().json;
const P = $('Set Period').first().json;
const r = $input.first().json;
const id = r.JournalEntry && r.JournalEntry.Id;
const err = id ? '' : JSON.stringify(r.Fault || r.error || r).slice(0, 500);
const html = '<div style="font-family:Segoe UI,Arial;font-size:13px">' + (id
  ? '<p><b>Posted.</b> QuickBooks journal entry ' + p.docNumber + ' (id ' + id + ') dated ' + p.end + ' for ' + p.label + ', ' +
    p.debits.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) + '.</p>'
  : '<p style="color:#C00000"><b>Posting failed.</b> QuickBooks returned: ' + err.replace(/</g, '&lt;') + '</p>') + p.html + '</div>';
return [{ json: { subject: (id ? '[POSTED] ' : '[POST FAILED] ') + 'ROU leases ' + p.label + ' - ' + p.docNumber, html,
  log: { period: p.period, doc_number: p.docNumber, status: id ? 'posted' : 'failed', amount: p.debits, qbo_je_id: id ? String(id) : '',
    detail: id ? (p.flags.length + ' review flags') : err, run_at: P.runAt, execution_id: String($execution.id) } } }];
` } },
  output: [{ subject: '', html: '', log: {} }]
});

const notApproved = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Not Approved', position: [2880, 150], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `// Declined, or no answer before the approval link expired: nothing is posted.
const p = $('Build Proposal').first().json;
const P = $('Set Period').first().json;
const a = ($input.first().json.data || {});
const status = a.approved === false ? 'declined' : 'expired';
const why = status === 'declined' ? 'declined by email' : 'no response within ' + P.approvalDays + ' days';
return [{ json: { subject: '[NOT POSTED] ROU leases ' + p.label + ' - ' + p.docNumber + ' ' + status,
  html: '<div style="font-family:Segoe UI,Arial;font-size:13px"><p><b>Not posted</b> (' + why + '). Fix the register or QuickBooks and run the month again (MONTH_OVERRIDE = "' + p.period + '").</p></div>' + p.html,
  log: { period: p.period, doc_number: p.docNumber, status, amount: p.debits, qbo_je_id: '', detail: why, run_at: P.runAt, execution_id: String($execution.id) } } }];
` } },
  output: [{ subject: '', html: '', log: {} }]
});

const reportOnly = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Report Only', position: [2400, 300], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `// Nothing to approve: QuickBooks already agrees with the schedule, the entry cannot be
// posted (see issues), or SEND_FOR_APPROVAL is off. The report email already went out; just log it.
const p = $('Build Proposal').first().json;
const P = $('Set Period').first().json;
const status = p.issues.length ? 'cannot_post' : (p.payload ? 'report_only' : 'nothing_to_post');
return [{ json: { subject: p.subject, html: p.html,
  log: { period: p.period, doc_number: p.docNumber, status, amount: p.debits, qbo_je_id: '',
    detail: (p.issues.concat(p.flags)).join(' | ').slice(0, 2000), run_at: P.runAt, execution_id: String($execution.id) } } }];
` } },
  output: [{ subject: '', html: '', log: {} }]
});

const finish = node({
  type: 'n8n-nodes-base.noOp', version: 1,
  config: { name: 'Outcome', position: [4320, 0] },
  output: [{ subject: '', html: '', log: {} }]
});

const emailResult = node({
  type: 'n8n-nodes-base.microsoftOutlook', version: 2,
  config: {
    name: 'Email Result', position: [4560, -100],
    parameters: { resource: 'message', operation: 'send', toRecipients: expr("{{ $('Set Period').first().json.approver }}"), subject: expr('{{ $json.subject }}'),
      bodyContent: expr('{{ $json.html }}'), additionalFields: { bodyContentType: 'html' } },
    credentials: { microsoftOutlookOAuth2Api: { id: 'MLhN5eoDaYrrb4sO', name: 'Microsoft Outlook account' } }
  },
  output: [{ id: 'AAMk' }]
});

const logRow = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Log Row', position: [4560, 200], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `// One row for the ROU Monthly Close log data table.
return $input.all().map(i => ({ json: i.json.log }));
` } },
  output: [{ period: '2026-09', doc_number: 'ROU-202609', status: 'posted' }]
});

const saveLog = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: {
    name: 'Save Close Log', position: [4800, 200],
    parameters: { resource: 'row', operation: 'insert', dataTableId: { __rl: true, mode: 'id', value: 'XkTCF4NnKqotzXNP', cachedResultName: 'ROU Monthly Close Log' },
      columns: { mappingMode: 'autoMapInputData', value: null }, options: {} }
  },
  output: [{ id: 1 }]
});

const note = sticky('## ROU lease month-end (ASC 842)\nRuns on the 5th for last month (or **Run Now**; set `MONTH_OVERRIDE` in **Set Period** to redo a month).\n1. Builds every lease schedule from the **ROU Lease Register** data table.\n2. Reads QuickBooks: month-end Trial Balance (2000 / 2001 / 2320 / 2600), rent posted per lease, ROU entries already posted.\n3. Proposes JE **ROU-YYYYMM** that brings QuickBooks to the schedule; emails the report + **ROU_Rollforward_YYYY-MM.xlsx**, then a second email with **Approve and post / Decline**.\n4. On approve: re-checks nothing changed, posts, emails the result and logs it in **ROU Monthly Close Log**.\nLease changes: edit the Register sheet of the workbook and upload it on the **ROU Lease Register Upload** form (or edit the data table), then re-run the month.\nSource: QBO-PO repo, n8n/rou-lease-month-end/.', [setPeriod, getRegister, getTb, getGl, findJe, buildProposal], { color: 4 });


export default workflow('rou-lease-month-end', 'QBO - ROU Lease Month-End JE (approval by email)')
  .add(runNow)
  .to(setPeriod)
  .add(monthly)
  .to(setPeriod)
  .add(calledByUpload)
  .to(setPeriod)
  .to(getRegister)
  .to(getTb)
  .to(getGl)
  .to(findJe)
  .to(buildProposal)
  .to(buildWorkbook)
  .to(emailWorkbook)
  .to(ifSend
    .onTrue(askApproval.to(ifApproved
      .onTrue(recheckJe.to(recheckTb.to(guard.to(ifClear
        .onTrue(postJe.to(posted.to(finish)))
        .onFalse(finish)))))
      .onFalse(notApproved.to(finish))))
    .onFalse(reportOnly.to(logRow)))
  .add(finish)
  .to(emailResult)
  .add(finish)
  .to(logRow)
  .add(logRow)
  .to(saveLog)
  .add(note);
