// Monthly ROU roll-forward workbook (ROU_Rollforward_YYYY-MM.xlsx), attached to the
// proposal email. Sheets: Summary (balances, JE, review items), Rollforward (this month
// by lease), YTD Rollforward (each month of the year, all leases), Schedules (every
// lease month by month to the end of its term), Register (the ROU Lease Register; edit
// it and upload the file on the ROU Lease Register Upload form), Instructions.
// n8n has no Excel library in Code nodes, so the .xlsx is written directly (zlib only).
const zlib = require('zlib');
const p = $('Build Proposal').first().json;
const P = $('Set Period').first().json;
const reg = $('Get Lease Register').all().map(i => i.json).filter(r => r.lease_id);
const A = P.accounts;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

// ---------- cells: number | string | { v, s } with s in title, h (header), b (bold), m (money), bm (bold money), pct ----------
const S = { title: 1, h: 2, b: 3, m: 4, bm: 5, pct: 6, wrap: 7 };
const sheets = [];
const sheet = (name, widths) => { const sh = { name, widths, rows: [] }; sheets.push(sh); return sh; };
const M = v => (v === '' || v === null || v === undefined ? '' : { v: r2(v), s: 'm' });
const BM = v => ({ v: r2(v), s: 'bm' });
const B = v => ({ v, s: 'b' });
const H = list => list.map(v => ({ v, s: 'h' }));

// ---------- Summary ----------
const status = p.issues.length ? 'CANNOT POST: ' + p.issues.join('; ')
  : !p.payload ? 'Nothing to post - QuickBooks agrees with the schedule'
  : P.sendForApproval ? 'Proposed - awaiting email approval (JE ' + p.docNumber + ')' : 'Report only - not sent for approval';
const sum = sheet('Summary', [34, 18, 18, 18, 18, 18, 60]);
sum.rows.push([{ v: 'Panda Holdings LLC - ROU lease roll-forward (ASC 842)', s: 'title' }]);
sum.rows.push(['Period', p.label + ' (' + p.end + ')']);
sum.rows.push(['Journal entry', p.docNumber + ' - ' + status]);
sum.rows.push(['Prepared', P.runAt + ' by the n8n ROU Lease Month-End workflow']);
sum.rows.push([]);
sum.rows.push([B('Balances (debit +, credit -)')]);
sum.rows.push(H(['Account', 'Schedule last month', 'QuickBooks before JE', 'This JE', 'QuickBooks after JE', 'Schedule this month', 'Difference after JE']));
for (const k of Object.keys(p.target)) {
  const after = r2(p.qbo[k] + p.delta[k]);
  sum.rows.push([A[k].name, M(p.prior[k]), M(p.qbo[k]), M(p.delta[k]), M(after), M(p.target[k]), M(r2(after - p.target[k]))]);
}
const lt = () => r2(p.target.current + p.target.noncurrent);
sum.rows.push([B('Net ROU asset'), BM(p.prior.rou + p.prior.accum), BM(p.qbo.rou + p.qbo.accum), BM(p.delta.rou + p.delta.accum), BM(p.qbo.rou + p.qbo.accum + p.delta.rou + p.delta.accum), BM(p.target.rou + p.target.accum), '']);
sum.rows.push([B('Total lease liability'), BM(p.prior.current + p.prior.noncurrent), BM(p.qbo.current + p.qbo.noncurrent), BM(p.delta.current + p.delta.noncurrent), BM(p.qbo.current + p.qbo.noncurrent + p.delta.current + p.delta.noncurrent), BM(lt()), '']);
sum.rows.push([]);
sum.rows.push([B('Journal entry ' + p.docNumber + ' dated ' + p.end)]);
sum.rows.push(H(['Account', 'Debit', 'Credit', '', '', '', 'Memo']));
for (const l of (p.payload || {}).Line || []) {
  const d = l.JournalEntryLineDetail;
  sum.rows.push([d.AccountRef.name, d.PostingType === 'Debit' ? M(l.Amount) : '', d.PostingType === 'Credit' ? M(l.Amount) : '', '', '', '', l.Description]);
}
sum.rows.push([B('Total'), BM(p.debits), BM(p.credits)]);
sum.rows.push([]);
if (p.issues.length || p.flags.length) {
  sum.rows.push([B('Review items')]);
  for (const x of p.issues) sum.rows.push(['CANNOT POST', { v: x, s: 'wrap' }]);
  for (const x of p.flags) sum.rows.push(['Review', { v: x, s: 'wrap' }]);
}

// ---------- Rollforward (this month, by lease) ----------
const rf = sheet('Rollforward', [28, 9, 16, 15, 14, 14, 16, 16, 16, 16, 16, 16, 16, 16, 16, 15, 15, 22]);
rf.rows.push([{ v: 'ROU roll-forward - ' + p.label, s: 'title' }]);
rf.rows.push(H(['Lease', 'Rate', 'Liability BOM', 'Remeasurement', 'Payments', 'Interest', 'Liability EOM', 'Current', 'Noncurrent',
  'Gross ROU BOM', 'Accum. amort. BOM', 'Net ROU BOM', 'Remeasurement', 'Amortization', 'Net ROU EOM', 'Lease expense', 'Rent in QBO', 'Status']));
const totals = {};
for (const l of p.leases) {
  const row = { bomL: l.bomL, adjL: l.adj, pay: l.pay, int: l.int, L: l.L, cur: l.cur, non: r2(l.L - l.cur), bomG: l.bomG, bomA: r2(l.bomR - l.bomG), bomR: l.bomR, adjR: l.adj, red: l.red, R: l.R, exp: l.exp };
  for (const [k, v] of Object.entries(row)) totals[k] = r2((totals[k] || 0) + v);
  rf.rows.push([l.name, l.rate === null ? '' : { v: l.rate, s: 'pct' }, M(row.bomL), M(row.adjL), M(-row.pay), M(row.int), M(row.L), M(row.cur), M(row.non),
    M(row.bomG), M(row.bomA), M(row.bomR), M(row.adjR), M(-row.red), M(row.R), M(row.exp), l.cashQbo === null ? '' : M(l.cashQbo), l.pending ? 'Modification pending' : (l.adj ? 'Remeasured' : '')]);
}
rf.rows.push([B('Total'), '', BM(totals.bomL), BM(totals.adjL), BM(-totals.pay), BM(totals.int), BM(totals.L), BM(totals.cur), BM(totals.non),
  BM(totals.bomG), BM(totals.bomA), BM(totals.bomR), BM(totals.adjR), BM(-totals.red), BM(totals.R), BM(totals.exp)]);
rf.rows.push([]);
rf.rows.push(['Check: liability BOM + remeasurement - payments + interest - EOM', '', M(r2(totals.bomL + totals.adjL - totals.pay + totals.int - totals.L))]);
rf.rows.push(['Check: net ROU BOM + remeasurement - amortization - EOM', '', M(r2(totals.bomR + totals.adjR - totals.red - totals.R))]);
if (p.shortTerm && p.shortTerm.length) {
  rf.rows.push([]);
  rf.rows.push([B('Short-term leases (expensed as paid, no ROU)')]);
  rf.rows.push(H(['Lease', '', 'Rent per lease', 'Rent in QBO', 'Term ends', 'Note']));
  for (const s of p.shortTerm) rf.rows.push([s.name, '', M(s.pay), s.cashQbo === null ? '' : M(s.cashQbo), s.end, s.notes]);
}

// ---------- YTD Rollforward (each month of the calendar year, all leases) ----------
const year = p.period.slice(0, 4);
const months = [];
for (let i = 1; i <= Number(p.period.slice(5, 7)); i++) months.push(year + '-' + String(i).padStart(2, '0'));
const agg = {};
for (const sc of p.schedules) for (const x of sc.rows) {
  if (!months.includes(x.m)) continue;
  const a = agg[x.m] = agg[x.m] || { bomL: 0, adj: 0, pay: 0, int: 0, L: 0, cur: 0, bomR: 0, red: 0, R: 0, exp: 0, G: 0 };
  for (const k of Object.keys(a)) a[k] = r2(a[k] + (x[k] || 0));
}
const ytd = sheet('YTD Rollforward', [30].concat(months.map(() => 15)).concat([16]));
ytd.rows.push([{ v: 'ROU monthly roll-forward ' + year + ' - all leases (schedule)', s: 'title' }]);
ytd.rows.push(H(['Month end'].concat(months).concat(['YTD'])));
const line = (label, f, flow, bold) => {
  const vals = months.map(m => f(agg[m] || {}));
  const total = flow ? r2(vals.reduce((s, v) => s + v, 0)) : '';
  ytd.rows.push([bold ? B(label) : label].concat(vals.map(v => bold ? BM(v) : M(v))).concat([total === '' ? '' : (bold ? BM(total) : M(total))]));
};
ytd.rows.push([B('Lease liability')]);
line('Beginning liability', a => a.bomL || 0);
line('Remeasurement / additions', a => a.adj || 0, true);
line('Payments', a => -(a.pay || 0), true);
line('Interest accretion', a => a.int || 0, true);
line('Ending liability', a => a.L || 0, false, true);
line('  Current', a => a.cur || 0);
line('  Noncurrent', a => r2((a.L || 0) - (a.cur || 0)));
ytd.rows.push([B('ROU asset')]);
line('Beginning net ROU', a => a.bomR || 0);
line('Remeasurement / additions', a => a.adj || 0, true);
line('Amortization (ROU reduction)', a => -(a.red || 0), true);
line('Ending net ROU', a => a.R || 0, false, true);
line('  Gross ROU', a => a.G || 0);
line('  Accumulated amortization', a => r2((a.R || 0) - (a.G || 0)));
ytd.rows.push([B('P&L')]);
line('Straight-line lease expense', a => a.exp || 0, true);
line('  of which interest accretion', a => a.int || 0, true);
line('  of which ROU amortization', a => a.red || 0, true);

// ---------- Schedules (every lease, every month) ----------
const sch = sheet('Schedules', [28, 10, 15, 16, 14, 14, 16, 16, 16, 16, 16, 15, 16, 16, 15, 12]);
sch.rows.push([{ v: 'Lease schedules (beginning-of-month payments; interest = (opening liability - payment) x rate / 12)', s: 'title' }]);
sch.rows.push(H(['Lease', 'Month', 'Payment', 'Liability BOM', 'Remeasurement', 'Interest', 'Liability EOM', 'Current', 'Noncurrent', 'Net ROU BOM',
  'Amortization', 'Net ROU EOM', 'Gross ROU', 'Accum. amort.', 'Lease expense', 'Note']));
for (const sc of p.schedules) for (const x of sc.rows) {
  if (x.m < year + '-01') continue;
  if (!x.pay && !x.bomL && !x.L && !x.R && !x.adj && !x.pending) continue;
  sch.rows.push([sc.name, x.m, M(x.pay), M(x.bomL), M(x.adj), M(x.int), M(x.L), M(x.cur), M(r2(x.L - x.cur)), M(x.bomR), M(x.red), M(x.R), M(x.G), M(r2(x.R - x.G)), M(x.exp),
    x.pending ? 'pending' : (x.m === p.period ? '<- this month' : '')]);
}

// ---------- Register (round-trip: edit and upload) ----------
const COLS = ['lease_id', 'lease_name', 'segment', 'status', 'start_month', 'end_month', 'annual_rate', 'payments', 'opening_liability', 'opening_net_rou',
  'opening_gross_rou', 'straight_line_expense', 'rent_account_id', 'rent_account_name', 'class_id', 'cash_account_ids', 'cash_match', 'source', 'notes'];
const payText = v => {
  let list = v;
  if (typeof v === 'string' && v.trim().startsWith('[')) { try { list = JSON.parse(v); } catch (e) { return v; } }
  if (!Array.isArray(list)) return v == null ? '' : String(v);
  return list.map(x => x.from + ': ' + Number(x.amount).toFixed(2)).join('; ');
};
const rg = sheet('Register', [12, 28, 9, 11, 12, 11, 11, 44, 16, 16, 16, 14, 11, 28, 10, 14, 26, 50, 60]);
rg.rows.push(H(COLS));
const sorted = reg.slice().sort((a, b) => String(a.lease_id).localeCompare(String(b.lease_id)) || Number(a.segment) - Number(b.segment));
for (const r of sorted) rg.rows.push(COLS.map(c => {
  const v = r[c];
  if (c === 'payments') return payText(v);
  if (v === null || v === undefined) return '';
  return typeof v === 'number' ? v : String(v);
}));

// ---------- Instructions ----------
const ins = sheet('Instructions', [110]);
[
  { v: 'How to update leases', s: 'title' },
  'The Register sheet is the lease register the workflow uses. One row per lease segment: segment 1 is the original lease with its opening balances; 2, 3... are renewals / amendments in date order.',
  'New amendment or renewal: add a row with the same lease_id, the next segment number, status active, start_month = month it takes effect (YYYY-MM), end_month = last month of the new term, annual_rate (e.g. 0.0415) and payments.',
  'New lease: add a row with a new lease_id, segment 1, status active, opening_liability = opening_net_rou = opening_gross_rou = PV of the payments at start_month, straight_line_expense blank (computed).',
  'Short-term lease (12 months or less, short-term election): status short_term. It is listed but not capitalized.',
  'Inputs not final yet: status pending. The lease is flagged every month and nothing is recognized for that segment.',
  'payments: rent steps as "YYYY-MM: amount; YYYY-MM: amount", e.g. "2026-09: 2502.70; 2027-09: 2596.32; 2028-09: 2674.21". Payments are at the beginning of each month.',
  'Then upload this file on the "ROU Lease Register Upload" form (n8n). You get an email listing every change with Approve / Decline; Approve replaces the register and, if you entered a month, re-runs that month.',
  'Do not rename the Register sheet or its column headers. Other sheets are ignored on upload.',
].forEach(t => ins.rows.push([typeof t === 'string' ? { v: t, s: 'wrap' } : t]));

// ---------- xlsx writer ----------
const C = String.fromCharCode;
const CTRL = new RegExp('[' + C(0) + '-' + C(8) + C(11) + C(12) + C(14) + '-' + C(31) + ']', 'g');
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(CTRL, '');
const colName = i => { let s = ''; i += 1; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const sheetXml = sh => {
  let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
  if (sh.name !== 'Instructions' && sh.name !== 'Summary') x += '<sheetViews><sheetView workbookViewId="0"><pane ySplit="' + (sh.name === 'Register' ? 1 : 2) + '" topLeftCell="A' + (sh.name === 'Register' ? 2 : 3) + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  x += '<cols>' + sh.widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols><sheetData>';
  sh.rows.forEach((row, ri) => {
    x += '<row r="' + (ri + 1) + '">';
    row.forEach((c, ci) => {
      if (c === '' || c === null || c === undefined) return;
      const cell = typeof c === 'object' ? c : { v: c };
      const ref = colName(ci) + (ri + 1);
      const st = cell.s ? ' s="' + S[cell.s] + '"' : '';
      if (typeof cell.v === 'number' && isFinite(cell.v)) x += '<c r="' + ref + '"' + st + '><v>' + cell.v + '</v></c>';
      else x += '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(cell.v) + '</t></is></c>';
    });
    x += '</row>';
  });
  return x + '</sheetData></worksheet>';
};
const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00;(#,##0.00);&quot;-&quot;"/><numFmt numFmtId="165" formatCode="0.00%"/></numFmts>' +
  '<fonts count="4"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font><font><b/><sz val="13"/><color rgb="FF1F3864"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/></patternFill></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8">' +
  [[0, 0, 0, 0, ''], [0, 2, 0, 0, ''], [0, 3, 2, 0, '<alignment wrapText="1" vertical="center"/>'], [0, 1, 0, 0, ''], [164, 0, 0, 0, ''], [164, 1, 0, 1, ''], [165, 0, 0, 0, ''],
    [0, 0, 0, 0, '<alignment wrapText="1" vertical="top"/>']].map(([n, f, fi, b, al]) => '<xf numFmtId="' + n + '" fontId="' + f + '" fillId="' + fi + '" borderId="' + b + '" xfId="0"' +
    (n ? ' applyNumberFormat="1"' : '') + (f ? ' applyFont="1"' : '') + (fi ? ' applyFill="1"' : '') + (b ? ' applyBorder="1"' : '') + (al ? ' applyAlignment="1">' + al + '</xf>' : '/>')).join('') +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
const files = [
  ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>'],
  ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
  ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets.map((s, i) => '<sheet name="' + xmlEsc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
    '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
  ['xl/styles.xml', styles],
].concat(sheets.map((s, i) => ['xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s)]));

const crcTable = [];
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
const crc32 = buf => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const locals = [];
const central = [];
let offset = 0;
for (const [name, text] of files) {
  const raw = Buffer.from(text, 'utf8');
  const comp = zlib.deflateRawSync(raw);
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(raw);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
  locals.push(lh, nameBuf, comp);
  central.push(ch, nameBuf);
  offset += 30 + nameBuf.length + comp.length;
}
const cdSize = central.reduce((s, b) => s + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
const xlsx = Buffer.concat(locals.concat(central).concat([end]));

const fileName = 'ROU_Rollforward_' + p.period + '.xlsx';
return [{ json: { fileName, bytes: xlsx.length, sheets: sheets.map(s => s.name) },
  binary: { workbook: { data: xlsx.toString('base64'), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName, fileExtension: 'xlsx' } } }];
