// Nothing to approve (nothing to post, cannot post, or SEND_FOR_APPROVAL is off). The
// report email already went out; log it.
const p = $('Build Proposal').first().json;
const P = $('Set Period').first().json;
const status = p.issues.length ? 'cannot_post' : (p.toPostDocs.length ? 'report_only' : 'nothing_to_post');
return [{ json: { skipEmail: true, moves: [],
  log: { period: p.period, status, doc_numbers: p.toPostDocs.join(', '), wip_to_cogs: 0, inventory_trueup: 0, qbo_je_ids: '',
    detail: p.issues.concat(p.flags).join(' | ').slice(0, 2000), run_at: P.runAt, execution_id: String($execution.id) } } }];
