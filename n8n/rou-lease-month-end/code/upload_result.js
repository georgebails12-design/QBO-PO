// Outcome of an upload, for the result email: loaded, declined / expired, invalid, or no changes.
const v = $('Validate Upload').first().json;
let loaded = false;
try { loaded = $('Insert Register Rows').all().length > 0; } catch (e) { loaded = false; }
let decision = null;
try { decision = ($('Email Changes for Approval').first().json.data || {}).approved; } catch (e) { decision = null; }
let status, msg;
if (loaded) {
  status = 'loaded';
  msg = '<p><b>Register updated</b> with ' + v.rows.length + ' rows from ' + v.file + '.' +
    (v.rerunMonth ? ' The ROU month-end for <b>' + v.rerunMonth + '</b> is running now; its proposal email follows.' : ' Re-run any month affected (MONTH_OVERRIDE in the ROU month-end workflow, or upload again with a re-run month).') + '</p>';
} else if (!v.valid) { status = 'invalid'; msg = '<p><b>Register not changed</b> - the upload has errors.</p>'; }
else if (!v.needsApproval) { status = 'no_changes'; msg = '<p><b>Register not changed</b> - nothing differs from the current register.</p>'; }
else { status = decision === false ? 'declined' : 'expired'; msg = '<p><b>Register not changed</b> - ' + (decision === false ? 'declined by email' : 'no response before the approval link expired') + '.</p>'; }
return [{ json: { status, rerun: loaded && !!v.rerunMonth, month: v.rerunMonth,
  subject: '[' + status.toUpperCase().replace('_', ' ') + '] ROU Lease Register upload - ' + v.file,
  html: '<div style="font-family:Segoe UI,Arial;font-size:13px">' + msg + '</div>' + v.html } }];
