// Result of posting the approved entry.
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
