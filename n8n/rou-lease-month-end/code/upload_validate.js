// Register sheet of an uploaded ROU workbook -> checked, normalized register rows, and
// what changes against the current ROU Lease Register. Nothing is written here: the
// changes are emailed for approval first.
// A new active segment 1 with no opening_liability is treated as a new lease: its
// opening liability, net ROU and gross ROU are set to the PV of its payments.
const F = $('Upload Form').first().json;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const COLS = ['lease_id', 'lease_name', 'segment', 'status', 'start_month', 'end_month', 'annual_rate', 'payments', 'opening_liability', 'opening_net_rou',
  'opening_gross_rou', 'straight_line_expense', 'rent_account_id', 'rent_account_name', 'class_id', 'cash_account_ids', 'cash_match', 'source', 'notes'];
const NUM = ['segment', 'annual_rate', 'opening_liability', 'opening_net_rou', 'opening_gross_rou', 'straight_line_expense'];
const STATUS = ['active', 'pending', 'short_term'];
const NL = String.fromCharCode(10);
const errors = [];
const warnings = [];

const blank = v => v === undefined || v === null || String(v).trim() === '';
const toNum = (v, where) => {
  if (blank(v)) return null;
  const n = Number(String(v).replace(/[$,]/g, '').split(' ').join('').replace(/%$/, ''));
  if (!isFinite(n)) { errors.push(where + ': "' + v + '" is not a number'); return null; }
  return /% *$/.test(String(v)) ? n / 100 : n;
};
// Months may arrive as "2026-09", "2026-09-01", "9/1/2026", a date string, or an Excel serial number.
const toMonth = (v, where) => {
  if (blank(v)) return '';
  const s = String(v).trim();
  let m = s.match(/^([0-9]{4})-([0-9]{1,2})/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0');
  m = s.match(/^([0-9]{1,2})[/][0-9]{1,2}[/]([0-9]{4})$/) || s.match(/^([0-9]{1,2})[/]([0-9]{4})$/);
  if (m) return m[2] + '-' + m[1].padStart(2, '0');
  if (/^[0-9]{5}([.][0-9]+)?$/.test(s)) { const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000); return d.toISOString().slice(0, 7); }
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 7);
  errors.push(where + ': "' + v + '" is not a month (use YYYY-MM)');
  return '';
};
const ym2i = s => { const [y, m] = s.split('-').map(Number); return y * 12 + m - 1; };
const parsePayments = (v, where) => {
  if (blank(v)) return [];
  let list;
  const s = String(v).trim();
  if (s.startsWith('[')) {
    try { list = JSON.parse(s); } catch (e) { errors.push(where + ': payments JSON cannot be read'); return []; }
  } else {
    list = s.split(';').join(NL).split(NL).map(x => x.trim()).filter(Boolean).map(x => {
      const mm = x.match(/^([^ ]+) *[:=] *[$]?([0-9,.]+)$/);
      if (!mm) { errors.push(where + ': cannot read payment "' + x + '" (use YYYY-MM: amount)'); return null; }
      return { from: toMonth(mm[1], where), amount: Number(mm[2].replace(/,/g, '')) };
    }).filter(Boolean);
  }
  return list.map(p => ({ from: toMonth(p.from, where), amount: r2(p.amount) })).filter(p => p.from).sort((a, b) => a.from.localeCompare(b.from));
};

// ---- 1. Rows from the Register sheet ----
const raw = $('Extract Register Sheet').all().map(i => i.json).filter(r => r && Object.keys(r).length);
const headerOk = raw.length && ['lease_id', 'segment', 'status', 'start_month', 'end_month'].every(c => c in raw[0]);
if (!raw.length) errors.push('No rows were read from a sheet named "Register". Upload the ROU_Rollforward workbook (or any .xlsx with a Register sheet).');
else if (!headerOk) errors.push('The Register sheet is missing column headers (needs lease_id, segment, status, start_month, end_month ...). Do not rename them.');

const rows = [];
const seen = {};
if (headerOk) raw.forEach((r, i) => {
  if (COLS.every(c => blank(r[c]))) return;
  const where = 'Register row ' + (i + 2) + (r.lease_id ? ' (' + r.lease_id + ')' : '');
  const o = {};
  for (const c of COLS) o[c] = NUM.includes(c) ? toNum(r[c], where + ' ' + c) : (blank(r[c]) ? '' : String(r[c]).trim());
  o.lease_id = o.lease_id.toUpperCase();
  o.status = (o.status || 'active').toLowerCase().replace(/[ -]+/g, '_');
  o.start_month = toMonth(r.start_month, where + ' start_month');
  o.end_month = toMonth(r.end_month, where + ' end_month');
  if (!o.lease_id) errors.push(where + ': lease_id is required');
  if (!Number.isInteger(o.segment) || o.segment < 1) errors.push(where + ': segment must be 1, 2, 3...');
  if (!STATUS.includes(o.status)) errors.push(where + ': status must be active, pending or short_term');
  if (!o.start_month || !o.end_month) errors.push(where + ': start_month and end_month are required');
  else if (o.end_month < o.start_month) errors.push(where + ': end_month is before start_month');
  if (o.annual_rate !== null && o.annual_rate > 0.25) { o.annual_rate = o.annual_rate / 100; warnings.push(where + ': annual_rate read as a percent (' + (o.annual_rate * 100).toFixed(3) + '%)'); }
  const pays = parsePayments(r.payments, where);
  if (o.status !== 'pending' && !pays.length) errors.push(where + ': payments are required');
  if (pays.length && o.start_month && pays[0].from > o.start_month) warnings.push(where + ': first payment starts ' + pays[0].from + ', after start_month ' + o.start_month);
  o.payments = JSON.stringify(pays);
  if (o.status === 'active' && o.annual_rate === null) errors.push(where + ': annual_rate is required for an active segment (or set status pending)');
  if (o.status === 'active' && o.segment === 1 && o.opening_liability === null && o.annual_rate !== null && pays.length && o.start_month && o.end_month) {
    const s = ym2i(o.start_month), e = ym2i(o.end_month);
    let pv = 0;
    for (let m = s; m <= e; m++) {
      let amt = 0;
      for (const p of pays) if (ym2i(p.from) <= m) amt = p.amount;
      pv += amt / Math.pow(1 + o.annual_rate / 12, m - s);
    }
    o.opening_liability = o.opening_net_rou = o.opening_gross_rou = r2(pv);
    warnings.push(where + ': new lease - opening liability / ROU set to the PV of payments, ' + r2(pv).toFixed(2) + ' (add initial direct costs or deduct incentives in opening_net_rou / opening_gross_rou if any)');
  }
  if (o.status === 'active' && o.segment === 1 && (o.opening_liability === null || o.opening_net_rou === null)) errors.push(where + ': segment 1 needs opening_liability and opening_net_rou');
  if (o.status === 'active' && !o.rent_account_id) errors.push(where + ': rent_account_id is required (QuickBooks account id for the straight-line line)');
  const key = o.lease_id + '|' + o.segment;
  if (seen[key]) errors.push(where + ': duplicate lease_id + segment ' + key.replace('|', ' segment '));
  seen[key] = true;
  rows.push(o);
});
const byLease = {};
rows.forEach(o => (byLease[o.lease_id] = byLease[o.lease_id] || []).push(o));
for (const [id, segs] of Object.entries(byLease)) {
  const cap = segs.filter(s => s.status !== 'short_term').sort((a, b) => a.segment - b.segment);
  for (let i = 1; i < cap.length; i++) if (cap[i].start_month <= cap[i - 1].start_month)
    errors.push(id + ': segment ' + cap[i].segment + ' must start after segment ' + cap[i - 1].segment);
}

// ---- 2. Changes against the current register ----
const norm = (c, v) => {
  if (v === null || v === undefined || v === '') return '';
  if (c === 'payments') { try { return JSON.stringify((typeof v === 'string' ? JSON.parse(v) : v).map(p => ({ from: String(p.from).slice(0, 7), amount: r2(p.amount) }))); } catch (e) { return String(v); } }
  if (NUM.includes(c)) return String(r2(Number(v) * (c === 'annual_rate' ? 10000 : 1)));
  return String(v).trim();
};
const cur = {};
$('Get Current Register').all().map(i => i.json).filter(r => r.lease_id).forEach(r => { cur[String(r.lease_id).toUpperCase() + '|' + r.segment] = r; });
const changes = [];
for (const o of rows) {
  const k = o.lease_id + '|' + o.segment;
  const c = cur[k];
  if (!c) { changes.push({ type: 'added', key: k, text: o.lease_name + ' segment ' + o.segment + ' (' + o.status + ', ' + o.start_month + ' to ' + o.end_month + ')' }); continue; }
  const diffs = COLS.filter(col => norm(col, c[col]) !== norm(col, o[col])).map(col => col + ': ' + (c[col] === null || c[col] === '' || c[col] === undefined ? '(blank)' : c[col]) + ' -> ' + (o[col] === null || o[col] === '' ? '(blank)' : o[col]));
  if (diffs.length) changes.push({ type: 'changed', key: k, text: o.lease_name + ' segment ' + o.segment + ': ' + diffs.join('; ') });
}
for (const k of Object.keys(cur)) if (!seen[k]) changes.push({ type: 'removed', key: k, text: (cur[k].lease_name || k) + ' segment ' + cur[k].segment + ' is not in the uploaded Register sheet and will be removed' });
if (rows.length && Object.keys(cur).length && changes.filter(c => c.type === 'removed').length > Object.keys(cur).length / 2)
  errors.push('More than half of the current register would be removed - is this the right file?');

// ---- 3. Email ----
const rerunRaw = String(F.rerun_month || '').trim();
const rerunMonth = rerunRaw ? toMonth(rerunRaw, 'Re-run month') : '';
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const file = (Object.values($('Upload Form').first().binary || {})[0] || {}).fileName || 'uploaded workbook';
const valid = !errors.length && rows.length > 0;
let html = '<div style="font-family:Segoe UI,Arial;font-size:13px"><p>ROU Lease Register upload: <b>' + esc(file) + '</b>' +
  (F.note ? '<br>Note: ' + esc(F.note) : '') + '<br>' + rows.length + ' register rows read.</p>';
if (errors.length) html += '<p style="color:#C00000"><b>Not loaded - fix these and upload again:</b></p><ul>' + errors.map(e => '<li>' + esc(e) + '</li>').join('') + '</ul>';
if (changes.length) html += '<h3>Changes to the register</h3><ul>' + changes.map(c => '<li><b>' + c.type + '</b> ' + esc(c.text) + '</li>').join('') + '</ul>';
else if (valid) html += '<p>No changes - the uploaded Register sheet matches the current register.</p>';
if (warnings.length) html += '<h3>Check</h3><ul>' + warnings.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul>';
if (valid && changes.length) html += '<p>Approve replaces the ROU Lease Register with the uploaded sheet' +
  (rerunMonth ? ' and re-runs the ROU month-end for <b>' + rerunMonth + '</b> (a new proposal email follows)' : '') + '. Decline changes nothing.</p>';
html += '</div>';
return [{ json: {
  valid, needsApproval: valid && changes.length > 0, errors, warnings, changes, rows, rerunMonth, file,
  subject: (!valid ? '[NOT LOADED] ' : changes.length ? '' : '[NO CHANGES] ') + 'ROU Lease Register upload - ' + file + (valid && changes.length ? ' - approve ' + changes.length + ' change(s)' : ''),
  html,
} }];
