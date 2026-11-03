// Declined, expired, or blocked by the guard: nothing is posted.
const p = $('Build Proposal').first().json;
const P = $('Set Period').first().json;
const j = $input.first().json;
let status, why;
if ('clear' in j) { status = 'blocked'; why = j.why; }
else { const a = j.data || {}; status = a.approved === false ? 'declined' : 'expired'; why = status === 'declined' ? 'declined by email' : 'no response within ' + P.approvalDays + ' days'; }
return [{ json: {
  subject: '[NOT POSTED] WIP, COGS & inventory month-end ' + p.label + ' - ' + status,
  html: '<div style="font-family:Segoe UI,Arial;font-size:13px"><p><b>Not posted</b> (' + String(why).replace(/</g, '&lt;') + '). Run the month again (Run Now with MONTH_OVERRIDE = "' + p.period + '" in Set Period) for a fresh proposal.</p></div>',
  moves: [],
  log: { period: p.period, status, doc_numbers: p.toPostDocs.join(', '), wip_to_cogs: 0, inventory_trueup: 0, qbo_je_ids: '', detail: String(why).slice(0, 2000), run_at: P.runAt, execution_id: String($execution.id) },
} }];
