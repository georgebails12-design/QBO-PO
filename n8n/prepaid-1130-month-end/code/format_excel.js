// One sheet, four blocks: reconciliation by account, the item roll-forward, the journal entry, and the month's GL detail.
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
