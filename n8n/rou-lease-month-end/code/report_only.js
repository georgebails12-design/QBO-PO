// Nothing to approve: QuickBooks already agrees with the schedule, the entry cannot be
// posted (see issues), or SEND_FOR_APPROVAL is off. The report email already went out; just log it.
const p = $('Build Proposal').first().json;
const P = $('Set Period').first().json;
const status = p.issues.length ? 'cannot_post' : (p.payload ? 'report_only' : 'nothing_to_post');
return [{ json: { subject: p.subject, html: p.html,
  log: { period: p.period, doc_number: p.docNumber, status, amount: p.debits, qbo_je_id: '',
    detail: (p.issues.concat(p.flags)).join(' | ').slice(0, 2000), run_at: P.runAt, execution_id: String($execution.id) } } }];
