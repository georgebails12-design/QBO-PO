// Pair each Post Journal Entry response with its entry; build the result email, the
// close-log row and the WIP to COGS Moves rows for the WIP entries that posted.
const p = $('Build Proposal').first().json;
const P = $('Set Period').first().json;
const sent = $('Guard Before Posting').all().map(i => i.json);
const resp = $input.all().map(i => i.json);
const money = n => (n < 0 ? '-$' : '$') + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const now = new Date().toISOString();
const res = sent.map((s, i) => {
  const r = resp[i] || {};
  const id = r.JournalEntry && r.JournalEntry.Id;
  return { doc: s.doc, key: s.key, total: s.total, id: id || '', err: id ? '' : JSON.stringify(r.Fault || r.error || r).slice(0, 400) };
});
const moves = [];
for (const r of res) {
  if (!r.id || r.key === 'INV') continue;
  const e = p.entries.find(x => x.doc === r.doc);
  for (const m of e.moves) moves.push(Object.assign({}, m, { qbo_je_id: String(r.id), posted_at: now }));
}
const failed = res.filter(r => !r.id);
const html = '<div style="font-family:Segoe UI,Arial;font-size:13px"><p><b>' + (failed.length ? failed.length + ' entr' + (failed.length > 1 ? 'ies' : 'y') + ' FAILED.' : 'Posted.') + '</b> WIP, COGS &amp; inventory month-end ' + p.label + ':</p><ul>' +
  res.map(r => '<li>' + r.doc + ' ' + money(r.total) + ' - ' + (r.id ? 'posted, QuickBooks JE id ' + r.id : 'FAILED: ' + r.err.replace(/</g, '&lt;')) + '</li>').join('') +
  (sent[0].skipped || []).map(s => '<li>' + s + ' - skipped</li>').join('') + '</ul></div>';
const sum = k => res.filter(r => r.id && (k === 'INV' ? r.key === 'INV' : r.key !== 'INV')).reduce((s, r) => s + r.total, 0);
return [{ json: {
  subject: (failed.length ? '[FAILED] ' : '[POSTED] ') + 'WIP, COGS & inventory month-end ' + p.label,
  html, moves,
  log: { period: p.period, status: failed.length ? (failed.length === res.length ? 'failed' : 'partly posted') : 'posted',
    doc_numbers: res.map(r => r.doc).join(', '), wip_to_cogs: Math.round(sum('WIP') * 100) / 100, inventory_trueup: Math.round(sum('INV') * 100) / 100,
    qbo_je_ids: res.map(r => r.id || 'failed').join(', '), detail: failed.map(f => f.doc + ': ' + f.err).join(' | ').slice(0, 2000),
    run_at: P.runAt, execution_id: String($execution.id) },
} }];
