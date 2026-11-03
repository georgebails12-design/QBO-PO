// WIP reconciliation, WIP -> COGS entries and the WASP inventory true-up for the month
// (read-only; nothing is posted here).
//  1. Every line in the four WIP sub-accounts through month end (GL detail) is tied to a
//     Shop Updates job: from "Job [..]" in a COGS entry's description, else its WASP pick
//     (amount, date, customer), else the QBO customer:project on the JE line.
//  2. Job status at month end from Shop Jobs Date Completed: OPEN (not completed, or
//     completed after month end), CUR (completed this month -> JE WIPCOGS-YYYY-MM),
//     PRIOR (completed earlier, still in WIP -> JE WIPCOGS-PRIOR-YYYY-MM if enabled),
//     UNASSIGNED (no job).
//  3. The parent account Inventory Asset:Work in Process holds the offset; it is
//     reported, never changed here.
//  4. WASP at month end (snapshot taken 11:50 PM on the last day, else live WASP rolled
//     back with the transactions since month end) vs QuickBooks raw-material balances
//     -> JE INVTRUEUP-YYYY-MM (Raw Materials vs the matching COGS account).
const P = $('Set Period').first().json;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const n0 = s => (s === undefined || s === null || s === '' ? 0 : Number(String(s).replace(/,/g, '')) || 0);
const U = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toUpperCase();
const money = n => (n < 0 ? '-$' : '$') + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const flags = [];
const issues = [];

const SUB = {
  '1150040007': { cat: 'Aluminum', cogs: '1150040013', cogsName: 'Inventory Cost of Goods Sold:COGS Aluminum' },
  '1150040008': { cat: 'Glass', cogs: '1150040014', cogsName: 'Inventory Cost of Goods Sold:COGS Glass' },
  '1150040009': { cat: 'Hardware', cogs: '1150040015', cogsName: 'Inventory Cost of Goods Sold:COGS Hardware' },
  '1150040011': { cat: 'Powder Coat', cogs: '1150040016', cogsName: 'Inventory Cost of Goods Sold:COGS Powder Coat' },
  '1150040012': { cat: 'Wood', cogs: '1150040017', cogsName: 'Inventory Cost of Goods Sold:COGS Wood' },
};
for (const [id, s] of Object.entries(SUB)) { s.id = id; s.name = 'Inventory Asset:Work in Process:WIP ' + s.cat; }

// ---------------- GL ----------------
const reqs = $('Build GL Requests').all().map(i => i.json);
const glPages = $('Get General Ledger').all().map(i => i.json);
const gl = {};
reqs.forEach((rq, i) => {
  const rows = [];
  const walk = list => {
    for (const r of list || []) {
      if (r.Rows) walk(r.Rows.Row);
      if (!r.ColData) continue;
      const c = r.ColData, v = c.map(x => x.value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v[0] || '')) continue;
      rows.push({ date: v[0], type: v[1], txnId: (c[1] && c[1].id) || '', doc: v[2] || '', name: v[3] || '', memo: v[4] || '', split: v[5] || '', amount: r2(n0(v[6])) });
    }
  };
  const pg = glPages[i] || {};
  if (pg.Fault || !pg.Rows) issues.push('QuickBooks GL for ' + rq.name + ' did not come back: ' + JSON.stringify(pg.Fault || pg).slice(0, 200));
  walk((pg.Rows || {}).Row);
  gl[rq.id] = rows;
});
// The parent's GL includes its sub-accounts; its own lines = parent minus subs.
const subCount = {};
const keyOf = r => [r.date, r.type, r.txnId, r.doc, r.memo, r.amount].join('|');
for (const id of Object.keys(SUB)) for (const r of gl[id] || []) subCount[keyOf(r)] = (subCount[keyOf(r)] || 0) + 1;
const parentOwn = [];
for (const r of gl['1115'] || []) { const k = keyOf(r); if (subCount[k] > 0) subCount[k]--; else parentOwn.push(r); }
const glBal = {};
for (const id of Object.keys(SUB)) glBal[id] = r2((gl[id] || []).reduce((s, r) => s + r.amount, 0));
const offsetBal = r2(parentOwn.reduce((s, r) => s + r.amount, 0));

// ---------------- JE lines (entity per WIP line) ----------------
const names = {};
const jeLine = {};   // txnId|amount|desc -> [entityId,...]
const jeLoose = {};  // txnId|amount -> [entityId,...] (fallback when the GL memo differs)
for (const page of $('Get WIP Journal Entries').all()) {
  for (const je of ((page.json.QueryResponse || {}).JournalEntry || [])) {
    for (const l of je.Line || []) {
      const d = l.JournalEntryLineDetail;
      if (!d || !SUB[d.AccountRef.value]) continue;
      const amt = r2((d.PostingType === 'Debit' ? 1 : -1) * n0(l.Amount));
      const ent = d.Entity && d.Entity.EntityRef ? d.Entity.EntityRef.value : '';
      if (ent) names[ent] = d.Entity.EntityRef.name;
      const k = je.Id + '|' + amt + '|' + (l.Description || '').trim();
      (jeLine[k] = jeLine[k] || []).push(ent);
      (jeLoose[je.Id + '|' + amt] = jeLoose[je.Id + '|' + amt] || []).push(ent);
    }
  }
}

// ---------------- jobs and picks ----------------
const jobsRaw = $('Get Shop Jobs').all().map(i => i.json).filter(r => r.job);
if (jobsRaw.length < 100) issues.push('Only ' + jobsRaw.length + ' rows in Shop Jobs Date Completed - did the nightly sync fail?');
const ptDate = v => {
  if (!v) return '';
  const d = DateTime.fromISO(String(v), { zone: 'utc' });
  return d.isValid ? d.setZone('America/Los_Angeles').toISODate() : String(v).slice(0, 10);
};
const JI = {};
for (const r of jobsRaw) {
  const k = String(r.job).split('/')[0].trim();
  if (k && !JI[k]) JI[k] = { job: k, customer: r.customer || '', production: r.production_name || '', group: r.group_name || '', jobType: r.job_type || '', completed: r.group_name === 'Completed' ? ptDate(r.date_completed) : '' };
}
const norm = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const byPrefix = {};
for (const k of Object.keys(JI)) { const n = norm(k); if (n.length >= 3) (byPrefix[n.slice(0, 3)] = byPrefix[n.slice(0, 3)] || []).push([k, n]); }
for (const l of Object.values(byPrefix)) l.sort((a, b) => b[1].length - a[1].length);
const jobOf = p => {
  p = String(p || ''); const np = norm(p);
  if (!np) return '';
  for (const [k, nk] of byPrefix[np.slice(0, 3)] || []) {
    if (np === nk || (np.startsWith(nk) && !/\d/.test(np[nk.length]))) return k;
    if (p.toUpperCase().startsWith(k.toUpperCase()) && !/\d/.test(p.charAt(k.length))) return k;
  }
  // "81492-PHASE 2" -> "81492.1-PHASE2": same base number and same trailing phase/suffix
  const base = (np.match(/^\d+/) || [''])[0], tail = np.slice(base.length);
  if (base && tail) for (const [k, nk] of byPrefix[np.slice(0, 3)] || []) if (nk.startsWith(base) && nk.endsWith(tail)) return k;
  return '';
};
const picks = $('Get Picks').all().map(i => i.json).filter(r => r.order_number)
  .map(r => ({ date: ptDate(r.asset_trans_date) || String(r.asset_trans_date || '').slice(0, 10), order: String(r.order_number), cust: U(r.customer_number), amt: r2(r.extended_cost), je: String(r.qbo_je_id || ''), item: r.asset_tag || '' }));
const pickByAmt = {};
picks.forEach((p, i) => { (pickByAmt[p.amt] = pickByAmt[p.amt] || []).push(i); });
const usedPick = new Set();
const dayDiff = (a, b) => Math.abs(DateTime.fromISO(a).diff(DateTime.fromISO(b), 'days').days);

// ---------------- WIP lines ----------------
const lines = [];
for (const [acct, s] of Object.entries(SUB)) {
  const seen = {};
  for (const r of gl[acct] || []) {
    const k = r.txnId + '|' + r.amount + '|' + r.memo.trim();
    const ents = jeLine[k] || jeLoose[r.txnId + '|' + r.amount] || [];
    const idx = seen[k] = (seen[k] || 0);
    seen[k]++;
    const ent = ents[idx] || ents[0] || '';
    const ename = names[ent] || r.name || '';
    let jobs = [], basis = '', pick = '';
    const m = r.memo.match(/^Job \[([^\]]+)\]/);
    if (m) { jobs = m[1].split(',').map(x => x.trim()).filter(Boolean); basis = 'COGS entry'; }
    else if (r.type === 'Journal Entry' && ename) {
      let best = -1;
      for (const i of pickByAmt[r.amount] || []) {
        if (usedPick.has(i)) continue;
        const p = picks[i];
        if (dayDiff(p.date, r.date) > 1 || !p.cust || !U(ename).includes(p.cust)) continue;
        if (p.je === r.txnId) { best = i; break; }
        if (best < 0) best = i;
      }
      if (best >= 0) {
        usedPick.add(best); pick = picks[best].order;
        const j = jobOf(pick);
        if (j) { jobs = [j]; basis = 'pick matched'; }
      }
    }
    lines.push({ acct, cat: s.cat, date: r.date, type: r.type, txnId: r.txnId, doc: r.doc, memo: r.memo, amount: r.amount, ent, ename, pick, jobs, basis });
  }
}
// Entity -> candidate jobs, for lines without a pick match.
const proj = n => U(String(n).includes(':') ? String(n).split(':').slice(1).join(':') : n);
const cand = {};
for (const l of lines) if (l.jobs.length && l.basis === 'pick matched') { const c = cand[l.ent] = cand[l.ent] || {}; c[l.jobs[0]] = (c[l.jobs[0]] || 0) + Math.abs(l.amount) + 1; }
const byCust = {};
for (const p of picks) { const j = jobOf(p.order); if (j && p.cust) { const c = byCust[p.cust] = byCust[p.cust] || {}; c[j] = (c[j] || 0) + 1; } }
const entCands = {};
for (const l of lines) {
  if (l.jobs.length || !l.ent) continue;
  if (!entCands[l.ent]) {
    const c = Object.assign({}, cand[l.ent] || {});
    if (!Object.keys(c).length) {
      const pr = proj(l.ename);
      for (const [cu, js] of Object.entries(byCust)) if (cu === pr || (cu.length >= 6 && pr.length >= 6 && (pr.startsWith(cu) || cu.startsWith(pr)))) for (const [j, v] of Object.entries(js)) c[j] = (c[j] || 0) + v;
      for (const [k, j] of Object.entries(JI)) {
        const pj = U(j.production);
        if ((k.length >= 5 && pr.includes(k.toUpperCase())) || (pj && pr.length >= 6 && (pj === pr || pj.startsWith(pr)))) c[k] = (c[k] || 0) + 0.5;
      }
    }
    entCands[l.ent] = Object.entries(c).sort((a, b) => b[1] - a[1]).map(e => e[0]);
  }
  l.jobs = entCands[l.ent];
  l.basis = l.jobs.length ? 'customer/project' : '';
}
const jstat = k => {
  const j = JI[k];
  if (!j) return ['UNASSIGNED', ''];
  const dc = j.completed;
  if (!dc || dc > P.end) return ['OPEN', dc && dc > P.end ? dc : ''];
  return [dc >= P.start ? 'CUR' : 'PRIOR', dc];
};
for (const l of lines) {
  const s = l.jobs.map(jstat);
  const kinds = new Set(s.map(x => x[0]));
  l.status = !s.length ? 'UNASSIGNED' : kinds.has('OPEN') ? 'OPEN' : kinds.has('UNASSIGNED') ? 'UNASSIGNED' : kinds.has('CUR') ? 'CUR' : 'PRIOR';
  l.completed = s.map(x => x[1]).sort().pop() || '';
  l.mixed = kinds.size > 1;
  l.jobKey = l.jobs.join(', ');
  l.key = (l.jobKey || '(none)') + ' | ' + (l.ename || '(no customer)');
  const j = JI[l.jobs[0]] || {};
  l.production = j.production || ''; l.group = j.group || '';
}
const STATUS = { OPEN: 'WIP - Open', CUR: 'COGS - This month', PRIOR: 'COGS - Completed earlier', UNASSIGNED: 'WIP - Unassigned' };
const tot = { OPEN: 0, CUR: 0, PRIOR: 0, UNASSIGNED: 0 };
for (const l of lines) tot[l.status] = r2(tot[l.status] + l.amount);
const jobWip = r2(Object.values(glBal).reduce((a, b) => a + b, 0));
const lineSum = r2(lines.reduce((s, l) => s + l.amount, 0));
if (Math.abs(lineSum - jobWip) >= 0.01) issues.push('WIP detail ' + money(lineSum) + ' does not equal the GL sub-accounts ' + money(jobWip));

// ---------------- WIP -> COGS entries ----------------
const existing = new Map();
for (const j of (($('Find Existing JEs').first().json.QueryResponse || {}).JournalEntry || [])) existing.set(j.DocNumber, j.Id);
const buildCogsJe = (st, doc, label) => {
  const g = new Map();
  for (const l of lines) {
    if (l.status !== st) continue;
    const k = l.key + '|' + l.acct;
    const o = g.get(k) || { key: l.key, jobKey: l.jobKey, ent: l.ent, ename: l.ename, acct: l.acct, completed: l.completed, amount: 0, picks: new Set() };
    o.amount = r2(o.amount + l.amount); if (l.pick) o.picks.add(l.pick); g.set(k, o);
  }
  const Line = [], moves = [];
  let total = 0;
  for (const o of [...g.values()].sort((a, b) => a.key.localeCompare(b.key) || a.acct.localeCompare(b.acct))) {
    if (Math.abs(o.amount) < 0.01) continue;
    const s = SUB[o.acct];
    const desc = ('Job [' + (o.jobKey || 'none') + '] - ' + o.ename + ' - completed ' + o.completed + ' - WIP ' + s.cat + ' to COGS ' + s.cat).slice(0, 4000);
    const entity = o.ent ? { Entity: { Type: 'Customer', EntityRef: { value: o.ent } } } : {};
    const amt = Math.abs(o.amount);
    const [dr, cr] = o.amount > 0 ? [s.cogs, s.id] : [s.id, s.cogs];
    Line.push({ Description: desc, Amount: amt, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: Object.assign({ PostingType: 'Debit', AccountRef: { value: dr } }, entity) });
    Line.push({ Description: desc, Amount: amt, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: Object.assign({ PostingType: 'Credit', AccountRef: { value: cr } }, entity) });
    total = r2(total + o.amount);
    moves.push({ job: o.jobKey || '(none)', wip_account: s.name, wip_account_id: s.id, cogs_account: s.cogsName, cogs_account_id: s.cogs,
      amount: o.amount, customer_qbo_id: o.ent, customer_name: o.ename, picks: [...o.picks].join(', ').slice(0, 500), txn_date: P.end, je_doc: doc, date_completed: o.completed || null });
  }
  if (!Line.length) return null;
  return { key: st, doc, label, total, moves, lines: Line.length,
    payload: { TxnDate: P.end, DocNumber: doc, PrivateNote: (label + ' - ' + P.label + '. Built by the n8n WIP, COGS & Inventory Month-End workflow.').slice(0, 4000), Line } };
};
const entries = [];
const jeCur = buildCogsJe('CUR', P.docWip, 'WIP to COGS for jobs completed in ' + P.label);
const jePrior = buildCogsJe('PRIOR', P.docPrior, 'WIP to COGS for jobs completed before ' + P.label + ' still in WIP');
if (jeCur) entries.push(jeCur);
if (jePrior) {
  if (P.includePrior) entries.push(jePrior);
  else flags.push(money(jePrior.total) + ' of WIP is on jobs completed before ' + P.label + ' (never moved to COGS). Listed on the COGS tab; set INCLUDE_PRIOR_COMPLETIONS = true in Set Period to move it.');
}
if (tot.UNASSIGNED) flags.push(money(tot.UNASSIGNED) + ' of WIP is not tied to a Shop Updates job (left in WIP - see the WIP tab).');

// ---------------- Inventory true-up ----------------
const RAW = {
  'ACM': '1114', 'ALUMINUM': '1114', 'ALUM - SMALL ITEMS': '1114', 'GLASS': '1112',
  'HARDWARE SMALL PARTS': '1111', 'SPECIAL HARDWARE': '1111', 'POWDER COATING': '1113',
  'SHOP SUPPLIES': '1150040019', 'WOOD AT P2': '1121', 'FINISH': '1103',
};
const INV = {
  '1114': { name: 'Inventory Asset:Raw Material - Aluminum', off: '1150040013', offName: 'Inventory Cost of Goods Sold:COGS Aluminum' },
  '1112': { name: 'Inventory Asset:Raw Materials - Glass', off: '1150040014', offName: 'Inventory Cost of Goods Sold:COGS Glass' },
  '1111': { name: 'Inventory Asset:Raw Materials - Hardware', off: '1150040015', offName: 'Inventory Cost of Goods Sold:COGS Hardware' },
  '1113': { name: 'Inventory Asset:Raw Materials - Powder Coat', off: '1150040016', offName: 'Inventory Cost of Goods Sold:COGS Powder Coat' },
  '1121': { name: 'Inventory Asset:Raw Materials - Wood', off: '1150040017', offName: 'Inventory Cost of Goods Sold:COGS Wood' },
  '1150040019': { name: 'Inventory Asset:Raw Materials - Shop Supplies', off: '873', offName: '5381 Shop Supplies' },
  '1103': { name: '1127 Capitalized Freight and Coating Expenses', off: '', offName: '', reportOnly: true },
};
// QBO balances at month end
const tb = {};
const walkTb = rows => { for (const r of rows || []) { if (r.Rows) walkTb(r.Rows.Row); const c0 = ((r.ColData || [])[0]) || {}; if (c0.id) tb[c0.id] = r2(n0(r.ColData[1] && r.ColData[1].value) - n0(r.ColData[2] && r.ColData[2].value)); } };
const tbRep = $('Get Trial Balance').first().json;
walkTb(tbRep.Rows && tbRep.Rows.Row);
if (!Object.keys(tb).length) issues.push('QuickBooks Trial Balance did not come back.');

// WASP at month end
const snap = $('Get WASP Snapshot').all().map(i => i.json).filter(r => r.month === P.period && r.item);
let invItems = [], waspSource = '', estimate = false;
if (snap.length) {
  const latest = snap.map(r => r.taken_at).sort().pop();
  invItems = snap.filter(r => r.taken_at === latest).map(r => ({ item: r.item, description: r.description, category: r.category, acct: r.gl_account, site: r.site, location: r.location,
    qty: n0(r.in_house), cost: n0(r.item_cost), live: r2(r.extended), after: 0, eom: r2(r.extended) }));
  waspSource = 'WASP snapshot taken ' + latest + ' PT';
} else {
  estimate = true;
  const text = String($('Get WASP Inventory').first().json.data || '');
  if (!text.includes('AssetTag')) issues.push('WASP inventory did not come back as CSV: ' + text.slice(0, 150));
  const csv = [];
  { let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) { const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); csv.push(row); row = []; f = ''; } else if (c !== '\r') f += c; }
    if (f || row.length) { row.push(f); csv.push(row); } }
  const hdr = csv.shift() || [];
  const ci = n => hdr.indexOf(n);
  const I = { tag: ci('AssetTag'), desc: ci('AssetDescription'), cat: ci('CategoryDescription'), cost: ci('ItemCost'), qty: ci('TotalInHouse'), site: ci('SiteName'), loc: ci('LocationCode') };
  const byItem = {};
  for (const r of csv) {
    if (I.tag < 0 || !r[I.tag]) continue;
    const qty = n0(r[I.qty]); if (!qty) continue;
    const cat = (r[I.cat] || '').trim() || '(blank)';
    const it = { item: r[I.tag], description: (r[I.desc] || '').replace(/\s+/g, ' ').trim(), category: cat, acct: RAW[cat.toUpperCase()] || '', site: r[I.site], location: r[I.loc], qty, cost: n0(r[I.cost]), live: r2(qty * n0(r[I.cost])), after: 0 };
    invItems.push(it); byItem[it.item + '|' + it.site + '|' + it.location] = it;
  }
  // Roll back what happened after month end (sign per transaction type).
  const SIGN = { 'Add': 1, 'Receive': 1, 'Check In By Vendor': 1, 'Unpick': 1, 'Return': 1, 'Pick': -1, 'Remove': -1, 'Check Out By Vendor': -1, 'Move To': 0, 'Move From': 0 };
  const seenSi = new Set(), unknown = {};
  const extra = {};
  for (const page of $('Get WASP Activity').all()) for (const t of (page.json.Data || [])) {
    if (t.SortingIndex != null) { if (seenSi.has(t.SortingIndex)) continue; seenSi.add(t.SortingIndex); }
    if (String(t.AssetTransDate || '').slice(0, 10) <= P.end) continue;
    const ty = t.TransTypeDescription || '';
    const ext = n0(t.AssetTransQuantity) * n0(t.AssetTransCost);
    if (!(ty in SIGN)) { unknown[ty] = r2((unknown[ty] || 0) + ext); continue; }
    if (!SIGN[ty]) continue;
    const cat = String(t.Category || '').trim() || '(blank)';
    const k = (t.AssetTag || '') + '|' + (t.SiteName || '') + '|' + (t.LocationCode || '');
    let it = byItem[k];
    if (!it) { it = extra[k] || (extra[k] = { item: t.AssetTag || '', description: String(t.AssetDescription || '').replace(/\s+/g, ' ').trim(), category: cat, acct: RAW[cat.toUpperCase()] || '', site: t.SiteName || '', location: t.LocationCode || '', qty: 0, cost: n0(t.AssetTransCost), live: 0, after: 0 }); }
    it.after = r2(it.after + SIGN[ty] * ext);
  }
  invItems = invItems.concat(Object.values(extra));
  for (const it of invItems) it.eom = r2(it.live - it.after);
  waspSource = 'live WASP at ' + P.runAt + ' PT rolled back to ' + P.end + ' with ' + seenSi.size + ' transactions since month end (ESTIMATE - no month-end snapshot)';
  for (const [ty, v] of Object.entries(unknown)) flags.push('WASP ' + ty + ' transactions since month end (' + money(v) + ') could not be rolled back - the true-up may be off by up to that.');
  if (!$('Get WASP Activity').all().length) issues.push('WASP transactions since month end did not come back.');
}
const waspBy = {};
for (const it of invItems) waspBy[it.acct || ''] = r2((waspBy[it.acct || ''] || 0) + it.eom);
if (waspBy['']) flags.push(money(waspBy['']) + ' of WASP on hand is in categories with no QuickBooks account (Inventory Detail, GL Account blank).');
const invRows = Object.entries(INV).map(([id, a]) => {
  const w = r2(waspBy[id] || 0), q = r2(tb[id] || 0), d = r2(w - q);
  return { id, name: a.name, wasp: w, qbo: q, diff: d, off: a.off, offName: a.offName,
    post: !a.reportOnly && Math.abs(d) >= P.minTrueup, note: a.reportOnly ? 'report only (no true-up account)' : (Math.abs(d) < P.minTrueup ? 'under ' + money(P.minTrueup) : '') };
});
let jeInv = null;
const invLines = [];
for (const r of invRows) {
  if (!r.post) continue;
  const amt = Math.abs(r.diff);
  const desc = 'Inventory true-up ' + P.label + ': WASP ' + money(r.wasp) + ' vs QuickBooks ' + money(r.qbo) + (estimate ? ' (WASP estimated)' : '');
  const [dr, cr] = r.diff > 0 ? [r.id, r.off] : [r.off, r.id];
  invLines.push({ Description: desc, Amount: amt, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: dr } } });
  invLines.push({ Description: desc, Amount: amt, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: cr } } });
}
const invNet = r2(invRows.filter(r => r.post).reduce((s, r) => s + r.diff, 0));
if (invLines.length) {
  jeInv = { key: 'INV', doc: P.docInv, label: 'Inventory true-up to WASP', total: invNet, moves: [], lines: invLines.length,
    payload: { TxnDate: P.end, DocNumber: P.docInv, PrivateNote: ('QuickBooks raw materials trued up to WASP at ' + P.end + ' (' + waspSource + '). Built by the n8n WIP, COGS & Inventory Month-End workflow.').slice(0, 4000), Line: invLines } };
  if (!P.includeTrueup) flags.push('Inventory true-up is off (INCLUDE_INVENTORY_TRUEUP = false); proposed only.');
  else if (estimate && !P.trueupFromLive) flags.push('No month-end WASP snapshot; true-up shown but not proposed (TRUEUP_FROM_LIVE_WASP = false).');
  else entries.push(jeInv);
}
if (estimate) flags.push('WASP month-end figures are an ESTIMATE: ' + waspSource + '.');

// Already in QuickBooks?
const toPost = [];
for (const e of entries) {
  if (existing.has(e.doc)) { e.already = existing.get(e.doc); flags.push(e.doc + ' is already in QuickBooks (JE id ' + e.already + ') - not posted again.'); }
  else toPost.push(e);
}

// ---------------- offset (parent account) ----------------
const ocat = r => {
  if (/WIP Acc|record WIP/i.test(r.memo)) return 'A. Monthly WIP accruals / reversals';
  if (r.type === 'Bill' && /COGS$/.test(r.doc)) return 'C. "<job> COGS" bills crediting WIP';
  if (r.type === 'Bill') return 'E. Vendor bills coded to WIP';
  if (/Pick/i.test(r.doc)) return 'B. Pick JEs posted to the parent account';
  if (/Ti$|Tieout|Trueup/i.test(r.doc)) return 'D. Inventory tie-out JEs';
  return 'F. Other';
};
const offset = {};
for (const r of parentOwn) { r.group = ocat(r); offset[r.group] = r2((offset[r.group] || 0) + r.amount); }
const offsetMonth = r2(parentOwn.filter(r => r.date >= P.start).reduce((s, r) => s + r.amount, 0));
if (Math.abs(offsetBal) >= 0.01) flags.push('The parent account Inventory Asset:Work in Process (offset) is ' + money(offsetBal) + ' (' + money(offsetMonth) + ' posted in ' + P.label + '). It is not changed by this workflow.');

// ---------------- email ----------------
const td = 'style="padding:4px 8px;border-bottom:1px solid #ddd"', tdr = 'style="padding:4px 8px;border-bottom:1px solid #ddd;text-align:right"';
const th = 'style="padding:4px 8px;background:#1F3864;color:#fff;text-align:left"';
const tbl = (head, rows) => '<table style="border-collapse:collapse;font-size:13px"><tr>' + head.map(h => '<th ' + th + '>' + h + '</th>').join('') + '</tr>' +
  rows.map(r => '<tr>' + r.map(c => typeof c === 'number' ? '<td ' + tdr + '>' + money(c) + '</td>' : '<td ' + td + '>' + String(c == null ? '' : c).replace(/</g, '&lt;') + '</td>').join('') + '</tr>').join('') + '</table>';
const afterWip = r2(jobWip - (jeCur ? jeCur.total : 0) - (P.includePrior && jePrior ? jePrior.total : 0));
let html = '<div style="font-family:Segoe UI,Arial;font-size:13px">';
html += '<p><b>WIP, COGS &amp; inventory month-end - ' + P.label + '</b> (as of ' + P.end + '). Full detail in the attached workbook (Summary, WIP, COGS, Inventory True-up, All Data).</p>';
if (issues.length) html += '<p style="color:#C00000"><b>Cannot post:</b> ' + issues.join('; ') + '</p>';
html += '<h3>WIP tie-out</h3>' + tbl(['', 'Amount'], [
  ['Job WIP in the WIP sub-accounts (GL)', jobWip], ['Open jobs - stays in WIP', tot.OPEN], ['Not tied to a job - stays in WIP', tot.UNASSIGNED],
  ['Completed in ' + P.label + ' - to COGS', tot.CUR], ['Completed earlier, still in WIP', tot.PRIOR],
  ['Offset - parent Work in Process account', offsetBal], ['Total Work in Process per GL', r2(jobWip + offsetBal)],
  ['Job WIP after the entries', afterWip]]);
html += '<h3>Inventory true-up (' + waspSource + ')</h3>' + tbl(['Account', 'WASP', 'QuickBooks', 'WASP - QBO', 'Note'], invRows.map(r => [r.name, r.wasp, r.qbo, r.diff, r.note]));
html += '<h3>Proposed journal entries dated ' + P.end + '</h3>' + (entries.length ? tbl(['Doc #', 'Entry', 'Lines', 'Amount', 'Status'], entries.map(e => [e.doc, e.label, e.lines, e.total, e.already ? 'already posted' : 'to post on approval'])) : '<p>None.</p>');
if (flags.length) html += '<h3>Review</h3><ul>' + flags.map(f => '<li>' + f.replace(/</g, '&lt;') + '</li>').join('') + '</ul>';
html += '<p style="color:#595959;font-size:12px">Sources: QuickBooks GL / journal entries / trial balance, WASP InventoryCloud, Shop Updates (Shop Jobs Date Completed). Run ' + P.runAt + ' PT by n8n.</p></div>';
const needsApproval = P.sendForApproval && toPost.length > 0 && !issues.length;
const approvalHtml = '<div style="font-family:Segoe UI,Arial;font-size:13px"><p>Approve to post these journal entries in QuickBooks, dated ' + P.end + ':</p>' +
  tbl(['Doc #', 'Entry', 'Lines', 'Amount'], toPost.map(e => [e.doc, e.label, e.lines, e.total])) +
  (estimate && toPost.some(e => e.key === 'INV') ? '<p style="color:#C00000">The inventory true-up uses an ESTIMATE of WASP at month end (no snapshot).</p>' : '') +
  '<p>Detail is in the WIP / COGS / Inventory workbook emailed just before this. Before posting, the workflow re-checks that none of these entries exist and that the WIP and raw-material balances have not changed.</p></div>';
const subject = (issues.length ? '[CANNOT POST] ' : '') + 'WIP, COGS & inventory month-end ' + P.label + ' - COGS ' + money(jeCur ? jeCur.total : 0) +
  (jeInv ? ', inventory true-up ' + money(invNet) + (estimate ? ' (est.)' : '') : '') + (flags.length ? ' - ' + flags.length + ' to review' : '');

return [{ json: {
  period: P.period, label: P.label, start: P.start, end: P.end, runAt: P.runAt,
  glBal, jobWip, offsetBal, offsetMonth, offset, tot, afterWip, statusLabels: STATUS,
  lines, parentOwn, invRows, invItems, waspSource, estimate,
  entries: entries.map(e => ({ key: e.key, doc: e.doc, label: e.label, total: e.total, lines: e.lines, already: e.already || '', payload: e.payload, moves: e.moves })),
  priorEntry: jePrior && !P.includePrior ? { doc: jePrior.doc, label: jePrior.label, total: jePrior.total, payload: jePrior.payload } : null,
  invEntryProposedOnly: jeInv && !entries.includes(jeInv) ? { doc: jeInv.doc, total: jeInv.total, payload: jeInv.payload } : null,
  toPostDocs: toPost.map(e => e.doc), issues, flags, html, approvalHtml, subject, needsApproval,
  sub: SUB, inv: INV,
} }];
