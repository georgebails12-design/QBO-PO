// Runs after Approve. Posts only if nothing changed since the proposal was emailed:
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
