// Prepaid (1130 + subs) amortization roll-forward, one row per prepaid item:
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
