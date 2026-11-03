// Runs after Approve. Posts only what is still safe:
//  - an entry whose DocNumber is already in QuickBooks is skipped;
//  - if the WIP sub-account or raw-material balances changed since the proposal was
//    emailed, nothing is posted (re-run the month for a fresh proposal).
const p = $('Build Proposal').first().json;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const n0 = s => (s === undefined || s === null || s === '' ? 0 : Number(String(s).replace(/,/g, '')) || 0);
const have = new Map();
for (const j of (($('Recheck Existing JEs').first().json.QueryResponse || {}).JournalEntry || [])) have.set(j.DocNumber, j.Id);
const tb = {};
const walk = rows => { for (const r of rows || []) { if (r.Rows) walk(r.Rows.Row); const c0 = ((r.ColData || [])[0]) || {}; if (c0.id) tb[c0.id] = r2(n0(r.ColData[1] && r.ColData[1].value) - n0(r.ColData[2] && r.ColData[2].value)); } };
const rep = $('Recheck Balances').first().json;
walk(rep.Rows && rep.Rows.Row);
const moved = [];
if (!Object.keys(tb).length) moved.push('the QuickBooks trial balance did not come back');
else {
  for (const [id, v] of Object.entries(p.glBal)) if (Math.abs((tb[id] || 0) - v) >= 0.01) moved.push(p.sub[id].name + ' was ' + v.toFixed(2) + ', now ' + (tb[id] || 0).toFixed(2));
  if (p.entries.some(e => e.key === 'INV')) for (const r of p.invRows) if (Math.abs((tb[r.id] || 0) - r.qbo) >= 0.01) moved.push(r.name + ' was ' + r.qbo.toFixed(2) + ', now ' + (tb[r.id] || 0).toFixed(2));
}
const skipped = [];
const post = [];
for (const e of p.entries) {
  if (!p.toPostDocs.includes(e.doc)) continue;
  if (have.has(e.doc)) { skipped.push(e.doc + ' already in QuickBooks (id ' + have.get(e.doc) + ')'); continue; }
  post.push(e);
}
if (moved.length || !post.length) {
  const why = moved.length ? 'balances changed after the proposal was sent (' + moved.join('; ') + ')' : 'every entry is already in QuickBooks (' + skipped.join('; ') + ')';
  return [{ json: { clear: false, why, skipped } }];
}
return post.map(e => ({ json: { clear: true, doc: e.doc, key: e.key, total: e.total, payload: e.payload, skipped } }));
