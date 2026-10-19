// Declined, or no answer before the approval link expired: nothing is posted.
const p = $('Build Proposal').first().json;
const P = $('Set Period').first().json;
const a = ($input.first().json.data || {});
const status = a.approved === false ? 'declined' : 'expired';
const why = status === 'declined' ? 'declined by email' : 'no response within ' + P.approvalDays + ' days';
return [{ json: { subject: '[NOT POSTED] ROU leases ' + p.label + ' - ' + p.docNumber + ' ' + status,
  html: '<div style="font-family:Segoe UI,Arial;font-size:13px"><p><b>Not posted</b> (' + why + '). Fix the register or QuickBooks and run the month again (MONTH_OVERRIDE = "' + p.period + '").</p></div>' + p.html,
  log: { period: p.period, doc_number: p.docNumber, status, amount: p.debits, qbo_je_id: '', detail: why, run_at: P.runAt, execution_id: String($execution.id) } } }];
