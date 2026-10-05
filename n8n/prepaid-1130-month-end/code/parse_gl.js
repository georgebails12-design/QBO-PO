// One item per 1130 account: GL beginning balance, the month's postings and the computed ending balance.
// Journal entry credits are treated as amortization already booked in QuickBooks this month.
const T = $('Find 1130 Accounts').first().json;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const num = s => (s === undefined || s === null || s === '' ? 0 : Number(String(s).replace(/,/g, '')) || 0);
const norm = s => String(s || '').replace(/^\d+(\.\d+)?\s+/, '').trim().toLowerCase();
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
