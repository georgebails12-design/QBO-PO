// One email: what moved (or would move, on a dry run), what was held and why,
// and jobs to look at. hasNews = false when there is nothing to say.
const S = $('Settings').first().json;
const B = $('Build Moves').first().json;
const jes = $('Build Journal Entries').all().map(i => i.json);
let posted = [];
try { posted = $('Post Journal Entry').all().map(i => i.json); } catch (e) { posted = []; }

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = n => (n < 0 ? '-$' : '$') + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const th = 'style="padding:4px 8px;background:#1F3864;color:#fff;text-align:left"';
const td = 'style="padding:4px 8px;border-bottom:1px solid #ddd"';
const tdr = 'style="padding:4px 8px;border-bottom:1px solid #ddd;text-align:right"';
const table = (head, rows) => '<table style="border-collapse:collapse;font-size:13px"><tr>' + head.map(h => '<th ' + th + '>' + h + '</th>').join('') + '</tr>' +
  rows.map(r => '<tr>' + r.map(c => typeof c === 'number' ? '<td ' + tdr + '>' + money(c) + '</td>' : '<td ' + td + '>' + esc(c) + '</td>').join('') + '</tr>').join('') + '</table>';

const real = jes.filter(j => !j.noEntries);
const held = (jes[0] && jes[0].heldAfterLookup) || [];
const results = real.map((j, i) => {
  if (S.dryRun) return 'dry run - not posted';
  const p = posted[i] || {};
  if (p.JournalEntry && p.JournalEntry.Id) return 'posted, QBO JE id ' + p.JournalEntry.Id;
  return 'FAILED: ' + JSON.stringify(p.error || p.Fault || p).slice(0, 300);
});
const failed = results.filter(r => r.startsWith('FAILED')).length;
const total = real.reduce((s, j) => s + j.total, 0);

let html = '<div style="font-family:Segoe UI,Arial;font-size:13px">';
html += '<p>Daily WIP to COGS for Shop Updates jobs completed ' + S.from + ' to ' + S.today + ' (' + B.jobsInScope + ' jobs checked).' +
  (S.dryRun ? ' <b>DRY RUN - nothing was posted to QuickBooks.</b> Set dryRun = false in Settings to post.' : '') + '</p>';
if (real.length) {
  html += '<h3>Journal entries</h3>' + table(['Doc #', 'Date', 'Dr COGS / Cr WIP', 'Result'], real.map((j, i) => [j.docNumber, j.txnDate, j.total, results[i]]));
  html += '<h3>Detail</h3>' + table(['Job', 'Production', 'Completed', 'WIP account', 'Amount', 'QBO customer', 'Picks', 'Open picks'],
    real.flatMap(j => j.moves).map(m => [m.job + (m.top_up ? ' (top-up)' : ''), m.production, m.date_completed, m.wip_account, m.amount, m.customer_name, m.picks, m.open_picks]));
} else html += '<p>Nothing to move today.</p>';
if (held.length) html += '<h3>Held - not moved</h3>' + table(['Job', 'Account', 'Amount', 'Reason'], held.map(h => [h.job, h.account || '', h.amount == null ? '' : h.amount, h.reason]));
if (B.flags.length) html += '<h3>Jobs to check</h3>' + table(['Job', 'Production', 'Completed', 'Flag'], B.flags.map(f => [f.job, f.production, f.completed, f.flag]));
html += '<p style="color:#595959;font-size:12px">Picked cost from WASP (same category to WIP account mapping as the Daily WASP Picks to WIP JE). Completed jobs from the Shop Jobs Date Completed data table. Moves are recorded in the WIP to COGS Moves data table. Sent by n8n.</p></div>';

const subject = (S.dryRun ? '[DRY RUN] ' : '') + (failed ? '[' + failed + ' FAILED] ' : '') +
  'WIP to COGS ' + S.today + ' - ' + money(total) + ' on ' + new Set(real.flatMap(j => j.moves.map(m => m.job))).size + ' jobs' +
  (held.length ? ', ' + held.length + ' held' : '');
return [{ json: { hasNews: real.length > 0 || held.length > 0, subject, html, total, failed } }];
