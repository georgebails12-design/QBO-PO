import { workflow, node, trigger, ifElse, sticky, expr } from '@n8n/workflow-sdk';

const runNow = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Now', position: [0, 0] }, output: [{}] });

const monthly = trigger({
  type: 'n8n-nodes-base.scheduleTrigger', version: 1.4,
  config: { name: '3rd of Month 6am', position: [0, 200], parameters: { rule: { interval: [{ field: 'months', monthsInterval: 1, triggerAtDayOfMonth: 3, triggerAtHour: 6, triggerAtMinute: 0 }] } } },
  output: [{}]
});

const setPeriod = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Set Period', position: [240, 100], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `// Month to close. Default: the previous calendar month (the schedule runs on the 3rd).
// To re-run a month, set MONTH_OVERRIDE = 'YYYY-MM'.
const MONTH_OVERRIDE = '';
// false = dry run: reconcile, update the roll-forward table and build the Excel, but do NOT post to QuickBooks.
// true  = also post the amortization journal entry (skipped if a JE with the same DocNumber already exists).
const POST_JE = false;

const tz = 'America/Los_Angeles';
const m = MONTH_OVERRIDE
  ? DateTime.fromISO(MONTH_OVERRIDE + '-01', { zone: tz })
  : $now.setZone(tz).minus({ months: 1 }).startOf('month');
return [{ json: {
  period: m.toFormat('yyyy-MM'),
  prevPeriod: m.minus({ months: 1 }).toFormat('yyyy-MM'),
  start: m.toFormat('yyyy-MM-dd'),
  end: m.endOf('month').toFormat('yyyy-MM-dd'),
  label: m.toFormat('MMM yyyy'),
  jeDoc: 'PP1130-' + m.toFormat('yyyyMM'),
  postJE: POST_JE,
} }];
` } },
  output: [{ period: '2026-09', prevPeriod: '2026-08', start: '2026-09-01', end: '2026-09-30', label: 'Sep 2026', jeDoc: 'PP1130-202609', postJE: false }]
});

const getRows = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: {
    name: 'Get Rollforward Rows', position: [480, 100], alwaysOutputData: true,
    parameters: {
      resource: 'row', operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: 'FkM0QGbbhz1dp1eE', cachedResultName: 'Prepaid Amortization Rollforward (1130)' },
      matchType: 'anyCondition',
      filters: { conditions: [
        { keyName: 'period', condition: 'eq', keyValue: expr('{{ $json.prevPeriod }}') },
        { keyName: 'period', condition: 'eq', keyValue: expr('{{ $json.period }}') }
      ] },
      returnAll: true
    }
  },
  output: [{ period: '2026-08', item_key: 'SEED|1088', eom: 1000 }]
});

const getAccounts = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {
    name: 'Get Accounts', position: [720, 100], executeOnce: true,
    parameters: {
      url: 'https://quickbooks.api.intuit.com/v3/company/9341454547526446/query', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true, queryParameters: { parameters: [{ name: 'query', value: 'select * from Account MAXRESULTS 1000' }, { name: 'minorversion', value: '75' }] },
      sendHeaders: true, headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] }, options: {}
    },
    credentials: { quickBooksOAuth2Api: { id: 'sFWFYsCNN6o8AYZG', name: 'QuickBooks Online account' } }
  },
  output: [{ QueryResponse: { Account: [] } }]
});

const findTree = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Find 1130 Accounts', position: [960, 100], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `// Account 1130 (by account number) and every sub-account under it, at any depth.
const accts = ($input.first().json.QueryResponse || {}).Account || [];
const byId = {};
accts.forEach(a => { byId[a.Id] = a; });
const root = accts.find(a => a.AcctNum === '1130');
if (!root) throw new Error('No QuickBooks account with account number 1130.');
const inTree = a => { for (let x = a; x; x = x.ParentRef ? byId[x.ParentRef.value] : null) if (x.Id === root.Id) return true; return false; };
const tree = accts.filter(inTree).map(a => ({
  id: a.Id, num: a.AcctNum || '', name: a.FullyQualifiedName, short: a.Name, active: a.Active,
}));
tree.sort((a, b) => (a.id === root.Id ? -1 : b.id === root.Id ? 1 : a.name.localeCompare(b.name)));
return [{ json: { rootId: root.Id, rootName: root.FullyQualifiedName, ids: tree.map(t => t.id).join(','), tree } }];
` } },
  output: [{ rootId: '1087', rootName: 'Prepaid Expense', ids: '1087,1089', tree: [] }]
});

const getGl = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {
    name: 'Get 1130 GL for Month', position: [1200, 100],
    parameters: {
      url: 'https://quickbooks.api.intuit.com/v3/company/9341454547526446/reports/GeneralLedger', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true, queryParameters: { parameters: [
        { name: 'account', value: expr('{{ $json.ids }}') },
        { name: 'start_date', value: expr("{{ $('Set Period').first().json.start }}") },
        { name: 'end_date', value: expr("{{ $('Set Period').first().json.end }}") },
        { name: 'accounting_method', value: 'Accrual' },
        { name: 'columns', value: 'tx_date,txn_type,doc_num,name,memo,split_acc,subt_nat_amount,rbal_nat_amount' },
        { name: 'minorversion', value: '75' }
      ] },
      sendHeaders: true, headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] }, options: {}
    },
    credentials: { quickBooksOAuth2Api: { id: 'sFWFYsCNN6o8AYZG', name: 'QuickBooks Online account' } }
  },
  output: [{ Rows: { Row: [] } }]
});

const getTb = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {
    name: 'Get Trial Balance', position: [1440, 100], executeOnce: true,
    parameters: {
      url: 'https://quickbooks.api.intuit.com/v3/company/9341454547526446/reports/TrialBalance', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true, queryParameters: { parameters: [
        { name: 'start_date', value: expr("{{ $('Set Period').first().json.start }}") },
        { name: 'end_date', value: expr("{{ $('Set Period').first().json.end }}") },
        { name: 'accounting_method', value: 'Accrual' },
        { name: 'minorversion', value: '75' }
      ] },
      sendHeaders: true, headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] }, options: {}
    },
    credentials: { quickBooksOAuth2Api: { id: 'sFWFYsCNN6o8AYZG', name: 'QuickBooks Online account' } }
  },
  output: [{ Rows: { Row: [] } }]
});

const parseGl = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Parse 1130 GL', position: [1680, 100], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `// One item per 1130 account: GL beginning balance, the month's postings and the computed ending balance.
// Journal entry credits are treated as amortization already booked in QuickBooks this month.
const T = $('Find 1130 Accounts').first().json;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const num = s => (s === undefined || s === null || s === '' ? 0 : Number(String(s).replace(/,/g, '')) || 0);
const norm = s => String(s || '').replace(/^\\d+(\\.\\d+)?\\s+/, '').trim().toLowerCase();
const idByName = {};
T.tree.forEach(a => { idByName[norm(a.name)] = a.id; idByName[norm(a.short)] = idByName[norm(a.short)] || a.id; });
const gl = {};
T.tree.forEach(a => { gl[a.id] = { begin: 0, rows: [] }; });
const walk = (rows, acctId) => {
  for (const r of rows || []) {
    if (r.Header || r.type === 'Section') {
      const h = ((r.Header || {}).ColData || [])[0] || {};
      const id = (h.id && gl[h.id]) ? h.id : (idByName[norm(h.value)] || acctId);
      walk(r.Rows && r.Rows.Row, id);
      continue;
    }
    if (!r.ColData || !acctId || !gl[acctId]) continue;
    const c = r.ColData.map(x => x.value);
    if (c[0] === 'Beginning Balance' || String(c[1] || '').startsWith('Beginning Balance')) { gl[acctId].begin = num(c[7] || c[6]); continue; }
    const amount = num(c[6]);
    if (!amount) continue;
    gl[acctId].rows.push({ date: c[0], type: c[1] || '', doc: c[2] || '', name: c[3] || '', memo: c[4] || '', split: c[5] || '', amount });
  }
};
const glRep = $('Get 1130 GL for Month').first().json;
walk(glRep.Rows && glRep.Rows.Row, T.rootId);

// QuickBooks Trial Balance at month end, as an independent check on the GL math.
const tb = {};
const tbWalk = rows => {
  for (const r of rows || []) {
    if (r.Rows) tbWalk(r.Rows.Row);
    if (!r.ColData) continue;
    const c0 = r.ColData[0] || {};
    if (c0.id) tb[c0.id] = r2(num(r.ColData[1] && r.ColData[1].value) - num(r.ColData[2] && r.ColData[2].value));
  }
};
const tbRep = $('Get Trial Balance').first().json;
tbWalk(tbRep.Rows && tbRep.Rows.Row);

return T.tree.map(a => {
  const rows = gl[a.id].rows;
  const jeCredits = r2(rows.filter(x => x.type === 'Journal Entry' && x.amount < 0).reduce((s, x) => s + x.amount, 0));
  const total = r2(rows.reduce((s, x) => s + x.amount, 0));
  return { json: { id: a.id, name: a.name, num: a.num, begin: r2(gl[a.id].begin), additions: r2(total - jeCredits),
    je_credits: jeCredits, end: r2(gl[a.id].begin + total), tb_end: tb[a.id] === undefined ? null : tb[a.id], rows } };
});
` } },
  output: [{ id: '1088', name: 'Prepaid Expense:Rent', num: '', begin: 0, additions: 0, je_credits: 0, end: 0, tb_end: 0, rows: [] }]
});

const buildRf = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Build Rollforward', position: [1920, 100], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `// Prepaid (1130 + subs) amortization roll-forward, one row per prepaid item:
//   BOM (last month's EOM from the data table) + Additions (this month's bills/checks/expenses into 1130)
//   - Amortization (straight line over term_months, starting start_period) = EOM.
// New additions get a default expense account / term from RULES below (first match wins), flagged for review.
// To change a schedule, edit the item's row in "Prepaid Amortization Rollforward (1130)":
//   - new this month: set term_months / start_period / expense_account_id on this month's row and re-run the month;
//   - carried item: set monthly_amort on this month's row and re-run, or remaining_months on last month's row.
//   - term_months = 0 means "expense the whole amount in start_period" (e.g. a trade show).
const RULES = [
  // sub: QBO account id of the 1130 sub-account; match: vendor/memo regex; exp: [expense account id, name]; cls: [class id, name]
  { sub: '1089', match: /guardian|dental|vision/i, exp: ['1002', 'Insurance:Vision & Dental'], term: 1, offset: 1 },
  { sub: '1089', match: /united ?health|health/i, exp: ['991', 'Insurance:Health Ins.'], term: 1, offset: 1 },
  { sub: '1089', match: /zurich|umbrella|liabil|general/i, exp: ['887', 'Insurance:General Liability Insurance'], term: 12, offset: 0 },
  { sub: '1089', exp: ['754', 'Insurance'], term: 12, offset: 0 },
  { sub: '1088', exp: ['788', 'Rent'], cls: ['811565', 'Operations'], term: 6, offset: 0 },
  { sub: '1151', exp: ['751', 'Dues and Subscriptions'], term: 12, offset: 0 },
  { sub: '1150', exp: ['856', 'Trade Show Expense'], cls: ['811562', 'Marketing'], term: 0, offset: null },
  { sub: '1087', match: /audit|armanino|cpa/i, exp: ['892', 'Professional Fees:Accounting Fees'], cls: ['811560', 'Office'], term: 12, offset: 0 },
  { sub: '1087', match: /roof|repair|maint/i, exp: ['790', 'Repairs:Building Repairs'], cls: ['811565', 'Operations'], term: 12, offset: 0 },
  { sub: '1087', match: /retainer|legal|law/i, exp: ['787', 'Professional Fees:Legal Fees'], cls: ['811565', 'Operations'], term: null, offset: 0 },
  { sub: '1087', exp: ['783', 'Licenses and Permits'], cls: ['811565', 'Operations'], term: 12, offset: 0 },
  { exp: ['', ''], term: null, offset: 0 },
];

const P = $('Set Period').first().json;
const T = $('Find 1130 Accounts').first().json;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const num = s => (s === undefined || s === null || s === '' ? 0 : Number(String(s).replace(/,/g, '')) || 0);
const blank = v => v === undefined || v === null || v === '';
const addMonths = (ym, n) => DateTime.fromISO(ym + '-01').plus({ months: n }).toFormat('yyyy-MM');
const acct = {};
T.tree.forEach(a => { acct[a.id] = a; });

// ---- 1. QuickBooks GL for the month, split by account (from Parse 1130 GL) ----
const gl = {};
$('Parse 1130 GL').all().forEach(i => { gl[i.json.id] = i.json; });

// ---- 2. Prior month (and any rows already saved for this month = manual overrides) ----
const saved = $('Get Rollforward Rows').all().map(i => i.json).filter(r => r.item_key);
const prior = saved.filter(r => r.period === P.prevPeriod);
const current = {};
saved.filter(r => r.period === P.period).forEach(r => { current[r.item_key] = r; });

const items = {};
for (const p of prior) {
  if (Math.abs(num(p.eom)) < 0.005) continue; // fully amortized last month
  items[p.item_key] = {
    item_key: p.item_key, sub_account_id: p.sub_account_id, sub_account: p.sub_account, vendor: p.vendor || '',
    description: p.description || '', source_doc: p.source_doc || '', expense_account_id: p.expense_account_id || '',
    expense_account: p.expense_account || '', start_period: p.start_period || '',
    term_months: blank(p.term_months) ? null : num(p.term_months), total_cost: num(p.total_cost),
    monthly_amort: num(p.monthly_amort),
    remaining: !blank(p.remaining_months) ? num(p.remaining_months) : (blank(p.term_months) ? null : num(p.term_months)),
    bom: r2(p.eom), additions: 0, isNew: false, isSeed: p.item_key.startsWith('SEED|'), defaulted: false, notes: p.notes || '',
  };
}

// First run (empty table): seed one opening-balance item per account from the GL beginning balance.
if (!prior.length) {
  for (const a of T.tree) {
    if (Math.abs(gl[a.id].begin) < 0.005) continue;
    const rule = RULES.find(x => (!x.sub || x.sub === a.id) && !x.match);
    items['SEED|' + a.id] = {
      item_key: 'SEED|' + a.id, sub_account_id: a.id, sub_account: a.name, vendor: '(opening balance)',
      description: 'Balance at ' + P.start + ' before this schedule started - split into items or set term_months (months left)',
      source_doc: 'GL beginning balance', expense_account_id: rule.exp[0], expense_account: rule.exp[1],
      start_period: P.period, term_months: null, total_cost: r2(gl[a.id].begin), monthly_amort: 0, remaining: null,
      bom: r2(gl[a.id].begin), additions: 0, isNew: true, isSeed: true, defaulted: true, notes: '',
    };
  }
}

// ---- 3. This month's additions: every non-JE posting into 1130/subs, plus JE debits (reclasses in) ----
for (const [id, g] of Object.entries(gl)) {
  for (const row of g.rows) {
    if (row.type === 'Journal Entry' && row.amount < 0) continue; // booked amortization / reclass out (see Parse 1130 GL)
    const key = P.period + '|' + id + '|' + row.type + '|' + row.doc + '|' + row.name;
    if (!items[key]) {
      const text = row.name + ' ' + row.memo;
      const rule = RULES.find(x => (!x.sub || x.sub === id) && (!x.match || x.match.test(text)));
      items[key] = {
        item_key: key, sub_account_id: id, sub_account: acct[id].name, vendor: row.name, description: '',
        source_doc: (row.type + ' ' + row.doc).trim() + ' (' + row.date + ')', expense_account_id: rule.exp[0],
        expense_account: rule.exp[1], start_period: rule.offset === null ? '' : addMonths(P.period, rule.offset),
        term_months: rule.term, total_cost: 0, monthly_amort: 0, remaining: null, bom: 0, additions: 0,
        isNew: true, defaulted: true, notes: '',
      };
    }
    const it = items[key];
    it.additions = r2(it.additions + row.amount);
    it.total_cost = r2(it.total_cost + row.amount);
    if (row.memo && !it.description.includes(row.memo)) it.description = (it.description ? it.description + '; ' : '') + row.memo;
  }
}

// ---- 4. Apply manual edits saved on this month's rows, then amortize ----
// Amortization already booked in QuickBooks by journal entry this month is applied to items that have no schedule yet
// (opening-balance rows first), so manual JEs are never reversed by the true-up.
const booked = {};
Object.values(gl).forEach(g => { booked[g.id] = -g.je_credits; });
const out = [];
const list = Object.values(items).sort((a, b) => (b.isSeed ? 1 : 0) - (a.isSeed ? 1 : 0));
for (const it of list) {
  const ov = current[it.item_key];
  let edited = false;
  if (ov) {
    for (const f of ['start_period', 'expense_account_id', 'expense_account', 'notes']) if (!blank(ov[f]) && ov[f] !== it[f]) { it[f] = ov[f]; edited = true; }
    if (it.isNew && !blank(ov.term_months) && num(ov.term_months) !== it.term_months) { it.term_months = num(ov.term_months); edited = true; }
    if (!it.isNew && it.remaining === null && !blank(ov.term_months)) { it.term_months = it.remaining = num(ov.term_months); it.monthly_amort = 0; edited = true; }
    if (!it.isNew && !blank(ov.monthly_amort) && num(ov.monthly_amort) !== it.monthly_amort) { it.monthly_amort = num(ov.monthly_amort); edited = true; }
  }
  if (it.isNew) it.remaining = it.term_months;

  const balance = r2(it.bom + it.additions);
  const started = !!it.start_period && it.start_period <= P.period;
  let amort = 0;
  let status;
  if (it.term_months === null || it.remaining === null) {
    status = it.isSeed ? 'SEED - set term_months (months left) on this row and re-run' : 'CHECK - no term set';
    const take = r2(Math.min(Math.max(balance, 0), booked[it.sub_account_id] || 0));
    if (take > 0) { amort = take; booked[it.sub_account_id] = r2(booked[it.sub_account_id] - take); status += ' | applied QB-booked JE amortization'; }
  } else if (!it.start_period) {
    status = 'CHECK - set start_period (YYYY-MM)';
  } else if (!started) {
    status = 'Not started (starts ' + it.start_period + ')';
  } else {
    if (it.isNew) it.monthly_amort = it.term_months > 0 ? r2(it.total_cost / it.term_months) : balance;
    if (it.term_months === 0 || it.remaining <= 1) amort = balance;
    else {
      const m = it.monthly_amort || r2(balance / it.remaining);
      amort = Math.sign(balance) * Math.min(Math.abs(balance), Math.abs(m));
    }
    amort = r2(amort);
    it.remaining = Math.max(0, it.remaining - 1);
    status = 'Amortizing';
  }
  const eom = r2(balance - amort);
  if (started && it.remaining !== null && Math.abs(eom) < 0.005 && amort) status = 'Fully amortized';
  if (balance < -0.005) status = 'CHECK - negative balance';
  if (it.isNew && it.defaulted && !edited && !it.isSeed && status !== 'CHECK - no term set') status = 'NEW - default term/account, review | ' + status;
  if (!it.expense_account_id && amort) status = 'CHECK - no expense account | ' + status;

  out.push({
    period: P.period, item_key: it.item_key, sub_account: it.sub_account, sub_account_id: it.sub_account_id,
    vendor: it.vendor, description: String(it.description || '').slice(0, 250), source_doc: it.source_doc,
    expense_account_id: it.expense_account_id, expense_account: it.expense_account,
    start_period: it.start_period, term_months: it.term_months, total_cost: r2(it.total_cost),
    monthly_amort: r2(it.monthly_amort), bom: r2(it.bom), additions: r2(it.additions), amortization: amort, eom,
    remaining_months: it.remaining, status, notes: it.notes,
    je_doc: P.postJE && amort ? P.jeDoc : '',
  });
}
out.sort((a, b) => a.sub_account.localeCompare(b.sub_account) || a.item_key.localeCompare(b.item_key));

return out.map(json => ({ json }));
` } },
  output: [{ period: '2026-09', item_key: 'SEED|1088', sub_account: 'Prepaid Expense:Rent', sub_account_id: '1088', vendor: '', description: '', source_doc: '', expense_account_id: '788', expense_account: 'Rent', start_period: '2026-09', term_months: 6, total_cost: 0, monthly_amort: 0, bom: 0, additions: 0, amortization: 0, eom: 0, remaining_months: 5, status: 'Amortizing', notes: '', je_doc: '' }]
});

const saveRows = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: {
    name: 'Save Rollforward Rows', position: [2160, 100],
    parameters: {
      resource: 'row', operation: 'upsert',
      dataTableId: { __rl: true, mode: 'id', value: 'FkM0QGbbhz1dp1eE', cachedResultName: 'Prepaid Amortization Rollforward (1130)' },
      matchType: 'allConditions',
      filters: { conditions: [
        { keyName: 'period', condition: 'eq', keyValue: expr('{{ $json.period }}') },
        { keyName: 'item_key', condition: 'eq', keyValue: expr('{{ $json.item_key }}') }
      ] },
      columns: { mappingMode: 'defineBelow', value: { period: expr('{{ $json.period }}'), item_key: expr('{{ $json.item_key }}'), sub_account: expr('{{ $json.sub_account }}'), sub_account_id: expr('{{ $json.sub_account_id }}'), vendor: expr('{{ $json.vendor }}'), description: expr('{{ $json.description }}'), source_doc: expr('{{ $json.source_doc }}'), expense_account_id: expr('{{ $json.expense_account_id }}'), expense_account: expr('{{ $json.expense_account }}'), start_period: expr('{{ $json.start_period }}'), term_months: expr('{{ $json.term_months }}'), total_cost: expr('{{ $json.total_cost }}'), monthly_amort: expr('{{ $json.monthly_amort }}'), bom: expr('{{ $json.bom }}'), additions: expr('{{ $json.additions }}'), amortization: expr('{{ $json.amortization }}'), eom: expr('{{ $json.eom }}'), remaining_months: expr('{{ $json.remaining_months }}'), status: expr('{{ $json.status }}'), notes: expr('{{ $json.notes }}'), je_doc: expr('{{ $json.je_doc }}') }, matchingColumns: [], schema: [] }
    }
  },
  output: [{ id: 1 }]
});

const buildRecon = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Build Recon & JE', position: [2400, 100], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `// Reconciliation of each 1130 account (schedule vs QuickBooks) and the month's amortization journal entry.
// Per account: if QuickBooks has no amortization JE yet this month, the JE has one Dr expense / Cr prepaid pair per
// amortizing item. If someone already booked amortization JEs, only the net difference is proposed (flagged to review).
const CLASS_BY_EXPENSE = { '788': '811565', '790': '811565', '787': '811565', '783': '811565', '856': '811562', '892': '811560' };
const P = $('Set Period').first().json;
const rows = $('Build Rollforward').all().map(i => i.json);
const gl = $('Parse 1130 GL').all().map(i => i.json);
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const sum = (list, k) => r2(list.reduce((s, x) => s + (Number(x[k]) || 0), 0));

const recon = [];
const lines = [];
const issues = [];
const line = (pt, acctId, acctName, amount, desc, classId) => {
  const d = { PostingType: pt, AccountRef: { value: acctId, name: acctName } };
  if (classId) d.ClassRef = { value: classId };
  lines.push({ DetailType: 'JournalEntryLineDetail', Amount: r2(amount), Description: String(desc).slice(0, 4000), JournalEntryLineDetail: d });
};
for (const a of gl) {
  const items = rows.filter(r => r.sub_account_id === a.id);
  const s = { bom: sum(items, 'bom'), add: sum(items, 'additions'), amort: sum(items, 'amortization'), eom: sum(items, 'eom') };
  const bomVar = r2(a.begin - s.bom);
  const eomVar = r2(a.end - s.eom);          // + = QuickBooks higher than the schedule (amortization not yet booked)
  const tbVar = a.tb_end === null ? null : r2(a.tb_end - a.end);
  let je = 0;
  const booked = Math.abs(a.je_credits) >= 0.005;
  if (!booked) {
    for (const it of items) {
      if (!it.amortization) continue;
      if (!it.expense_account_id) { issues.push(it.sub_account + ' / ' + it.vendor + ': no expense account'); continue; }
      const desc = 'Amortize prepaid ' + (it.vendor || '') + ' ' + (it.description || '') + ' - ' + P.label;
      const amt = Math.abs(it.amortization);
      const exp = CLASS_BY_EXPENSE[it.expense_account_id] || '';
      if (it.amortization > 0) { line('Debit', it.expense_account_id, it.expense_account, amt, desc, exp); line('Credit', a.id, a.name, amt, desc, ''); }
      else { line('Debit', a.id, a.name, amt, desc, ''); line('Credit', it.expense_account_id, it.expense_account, amt, desc, exp); }
      je = r2(je + it.amortization);
    }
  } else if (Math.abs(eomVar) >= 0.01 && items.some(x => x.remaining_months === null || x.term_months === null)) {
    issues.push(a.name + ': variance ' + eomVar + ' not trued up - some items have no term yet');
  } else if (Math.abs(eomVar) >= 0.01) {
    const it = items.find(x => x.expense_account_id) || {};
    if (!it.expense_account_id) issues.push(a.name + ': true-up of ' + eomVar + ' has no expense account');
    else {
      const desc = 'True-up prepaid ' + a.name + ' to amortization schedule - ' + P.label;
      const exp = CLASS_BY_EXPENSE[it.expense_account_id] || '';
      if (eomVar > 0) { line('Debit', it.expense_account_id, it.expense_account, eomVar, desc, exp); line('Credit', a.id, a.name, eomVar, desc, ''); }
      else { line('Debit', a.id, a.name, -eomVar, desc, ''); line('Credit', it.expense_account_id, it.expense_account, -eomVar, desc, exp); }
      je = eomVar;
    }
  }
  const after = r2(eomVar - je);
  let status = Math.abs(after) < 0.01 ? (je ? 'Ties after proposed JE' : 'Ties') : 'VARIANCE - review';
  if (Math.abs(bomVar) >= 0.01) status += ' | BOM differs from QB by ' + bomVar;
  if (booked) status += ' | QB already has amortization JEs (' + a.je_credits + ')';
  if (tbVar !== null && Math.abs(tbVar) >= 0.01) status += ' | GL vs Trial Balance off by ' + tbVar;
  recon.push({ id: a.id, name: (a.num ? a.num + ' ' : '') + a.name, sched_bom: s.bom, sched_add: s.add, sched_amort: s.amort,
    sched_eom: s.eom, gl_begin: a.begin, gl_add: a.additions, gl_je: a.je_credits, gl_end: a.end, tb_end: a.tb_end,
    bom_var: bomVar, eom_var: eomVar, proposed_je: je, var_after_je: after, items: items.length,
    flagged: items.filter(r => /^(CHECK|NEW|SEED)/.test(r.status)).length, status });
}

const debits = r2(lines.filter(l => l.JournalEntryLineDetail.PostingType === 'Debit').reduce((t, l) => t + l.Amount, 0));
const credits = r2(lines.filter(l => l.JournalEntryLineDetail.PostingType === 'Credit').reduce((t, l) => t + l.Amount, 0));
const payload = lines.length ? { TxnDate: P.end, DocNumber: P.jeDoc,
  PrivateNote: 'Prepaid (1130) amortization for ' + P.label + ' - generated by the n8n Prepaid 1130 month-end workflow.', Line: lines } : null;
return [{ json: { postJE: P.postJE, jeDoc: P.jeDoc, debits, credits, balanced: debits === credits, issues, recon, payload,
  shouldPost: P.postJE && !!payload && debits === credits && !issues.length } }];
` } },
  output: [{ postJE: false, jeDoc: 'PP1130-202609', debits: 0, credits: 0, balanced: true, issues: [], recon: [], payload: null, shouldPost: false }]
});

const findExisting = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {
    name: 'Find Existing JE', position: [2640, 100], executeOnce: true,
    parameters: {
      url: 'https://quickbooks.api.intuit.com/v3/company/9341454547526446/query', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true, queryParameters: { parameters: [
        { name: 'query', value: expr("select Id, DocNumber, TxnDate from JournalEntry where DocNumber = '{{ $json.jeDoc }}'") },
        { name: 'minorversion', value: '75' }
      ] },
      sendHeaders: true, headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] }, options: {}
    },
    credentials: { quickBooksOAuth2Api: { id: 'sFWFYsCNN6o8AYZG', name: 'QuickBooks Online account' } }
  },
  output: [{ QueryResponse: {} }]
});

const shouldPost = ifElse({
  version: 2.2,
  config: {
    name: 'Post JE?', position: [2880, 100],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ leftValue: expr("{{ $('Build Recon & JE').first().json.shouldPost && !(($json.QueryResponse || {}).JournalEntry || []).length }}"), operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and'
      }
    }
  }
});

const postJe = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {
    name: 'Post Journal Entry', position: [3120, 0],
    parameters: {
      method: 'POST', url: 'https://quickbooks.api.intuit.com/v3/company/9341454547526446/journalentry', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true, queryParameters: { parameters: [{ name: 'minorversion', value: '75' }] },
      sendHeaders: true, headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] }, sendBody: true, contentType: 'json', specifyBody: 'json',
      jsonBody: expr("{{ JSON.stringify($('Build Recon & JE').first().json.payload) }}"), options: { timeout: 60000 }
    },
    credentials: { quickBooksOAuth2Api: { id: 'sFWFYsCNN6o8AYZG', name: 'QuickBooks Online account' } }
  },
  output: [{ JournalEntry: { Id: '1' } }]
});

const formatExcel = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Format Excel Rows', position: [3360, 100], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `// One sheet, four blocks: reconciliation by account, the item roll-forward, the journal entry, and the month's GL detail.
const P = $('Set Period').first().json;
const R = $('Build Recon & JE').first().json;
const rows = $('Build Rollforward').all().map(i => i.json);
const gl = $('Parse 1130 GL').all().map(i => i.json);
const existing = (($('Find Existing JE').first().json.QueryResponse || {}).JournalEntry || [])[0];
let posted = null;
try { posted = ($('Post Journal Entry').first().json || {}).JournalEntry || null; } catch (e) { posted = null; }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

let jeStatus;
if (posted) jeStatus = 'POSTED to QuickBooks as JE ' + P.jeDoc + ' (Id ' + posted.Id + ')';
else if (existing) jeStatus = 'Not posted - JE ' + P.jeDoc + ' already exists in QuickBooks (Id ' + existing.Id + ')';
else if (!R.payload) jeStatus = 'No journal entry needed';
else if (!R.postJE) jeStatus = 'DRY RUN - JE not posted (set POST_JE = true in Set Period to post)';
else jeStatus = 'Not posted - ' + (R.issues.length ? R.issues.join('; ') : 'debits and credits do not balance');

const COLS = ['Section', 'Account', 'Vendor / Item', 'Description', 'Source Doc', 'Expense Account', 'Start', 'Term (mo)',
  'Remaining (mo)', 'Monthly', 'BOM', 'Additions', 'Amortization', 'EOM', 'QB Balance', 'Variance', 'Debit', 'Credit', 'Status'];
const out = [];
const add = o => { const r = {}; COLS.forEach(c => { r[c] = o[c] === undefined ? '' : o[c]; }); out.push(r); };

add({ Section: 'Prepaid 1130 month-end close - ' + P.label, Description: 'Period ' + P.start + ' to ' + P.end, Status: jeStatus });
add({});

// Block 1: reconciliation
add({ Section: 'RECONCILIATION', Description: 'Schedule (data table) vs QuickBooks GL; Amortization = schedule; QB Balance = GL ending balance' });
for (const r of R.recon) {
  add({ Section: 'Recon', Account: r.name, 'Vendor / Item': r.items + ' items, ' + r.flagged + ' flagged',
    Description: 'QB: begin ' + r.gl_begin + ' + additions ' + r.gl_add + ' + JEs ' + r.gl_je + (r.tb_end === null ? '' : ' | Trial Balance ' + r.tb_end),
    BOM: r.sched_bom, Additions: r.sched_add, Amortization: r.sched_amort, EOM: r.sched_eom, 'QB Balance': r.gl_end,
    Variance: r.eom_var, Debit: r.proposed_je > 0 ? r.proposed_je : '', Credit: r.proposed_je < 0 ? -r.proposed_je : '', Status: r.status });
}
const tot = k => r2(R.recon.reduce((s, r) => s + r[k], 0));
add({ Section: 'Recon', Account: 'TOTAL 1130 incl. sub-accounts', BOM: tot('sched_bom'), Additions: tot('sched_add'),
  Amortization: tot('sched_amort'), EOM: tot('sched_eom'), 'QB Balance': tot('gl_end'), Variance: tot('eom_var'),
  Status: 'Variance after proposed JE: ' + tot('var_after_je') });
add({});

// Block 2: item roll-forward
add({ Section: 'ROLL-FORWARD', Description: 'Saved to the "Prepaid Amortization Rollforward (1130)" data table; edit term/start/expense account there' });
for (const r of rows) {
  add({ Section: 'Item', Account: r.sub_account, 'Vendor / Item': r.vendor, Description: r.description, 'Source Doc': r.source_doc,
    'Expense Account': r.expense_account, Start: r.start_period, 'Term (mo)': r.term_months === null ? '' : r.term_months,
    'Remaining (mo)': r.remaining_months === null ? '' : r.remaining_months, Monthly: r.monthly_amort, BOM: r.bom,
    Additions: r.additions, Amortization: r.amortization, EOM: r.eom, Status: r.status });
}
add({});

// Block 3: journal entry
add({ Section: 'JOURNAL ENTRY', 'Vendor / Item': P.jeDoc, Description: 'TxnDate ' + P.end, Debit: R.debits, Credit: R.credits, Status: jeStatus });
for (const l of (R.payload || {}).Line || []) {
  const d = l.JournalEntryLineDetail;
  add({ Section: 'JE line', Account: d.AccountRef.name, Description: l.Description,
    Debit: d.PostingType === 'Debit' ? l.Amount : '', Credit: d.PostingType === 'Credit' ? l.Amount : '' });
}
add({});

// Block 4: what hit 1130 in QuickBooks this month
add({ Section: 'QB GL DETAIL', Description: 'All postings to 1130 and its sub-accounts in ' + P.label });
for (const a of gl) for (const x of a.rows) {
  add({ Section: 'GL', Account: a.name, 'Vendor / Item': x.name, Description: x.memo, 'Source Doc': (x.type + ' ' + x.doc).trim() + ' (' + x.date + ')',
    Additions: x.type === 'Journal Entry' && x.amount < 0 ? '' : x.amount, Amortization: x.type === 'Journal Entry' && x.amount < 0 ? x.amount : '' });
}
return out.map(json => ({ json }));
` } },
  output: [{ Section: 'Recon' }]
});

const createExcel = node({
  type: 'n8n-nodes-base.convertToFile', version: 1.1,
  config: {
    name: 'Create Excel', position: [3600, 100],
    parameters: {
      operation: 'xlsx', binaryPropertyName: 'data',
      options: {
        fileName: expr("Prepaid_1130_Rollforward_{{ $('Set Period').first().json.period }}.xlsx"),
        headerRow: true,
        sheetName: expr("{{ $('Set Period').first().json.label }}")
      }
    }
  },
  output: [{}]
});

const note = sticky('## Prepaid 1130 month-end close\n' +
  '1. Pulls 1130 Prepaid Expense and all sub-accounts (Insurance, Rent, Software, Trade Shows, ...) from QuickBooks: GL for the month + Trial Balance.\n' +
  '2. Rolls forward every prepaid item in the **Prepaid Amortization Rollforward (1130)** data table: BOM + additions - straight-line amortization = EOM. New bills/checks/expenses into 1130 become new items with a default term + expense account (rules in Build Rollforward), flagged NEW for review.\n' +
  '3. Reconciles schedule vs QuickBooks per sub-account and builds the amortization JE (DocNumber PP1130-YYYYMM).\n' +
  '4. Posts the JE only when POST_JE = true in Set Period and no JE with that number exists.\n' +
  '5. Last step: Excel workbook (recon, roll-forward, JE, GL detail).\n\n' +
  'First run seeds one opening-balance row per account: set term_months (months left) on those rows and re-run the month.',
  [setPeriod, getRows, getAccounts, findTree], { color: 4 });

export default workflow('prepaid-1130-close', 'QBO - Prepaid 1130 Month-End Amortization & Recon')
  .add(runNow)
  .to(setPeriod)
  .add(monthly)
  .to(setPeriod)
  .to(getRows)
  .to(getAccounts)
  .to(findTree)
  .to(getGl)
  .to(getTb)
  .to(parseGl)
  .to(buildRf)
  .to(saveRows)
  .to(buildRecon)
  .to(findExisting)
  .to(shouldPost.onTrue(postJe.to(formatExcel)).onFalse(formatExcel))
  .add(formatExcel)
  .to(createExcel)
  .add(note);
