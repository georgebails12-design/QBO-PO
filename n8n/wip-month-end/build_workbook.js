// Month-end workbook WIP_COGS_Inventory_YYYY-MM.xlsx: Summary, WIP, COGS, Inventory
// True-up, Inventory Detail, All Data. Totals are Excel formulas (SUMIFS on All Data /
// Inventory Detail) so every number can be traced; Excel recalculates on open.
// n8n has no Excel library in Code nodes, so the .xlsx is written directly (zlib only).
const zlib = require('zlib');
const p = $('Build Proposal').first().json;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const S = { title: 1, h: 2, b: 3, m: 4, bm: 5, note: 6, wrap: 7, chk: 8 };
const sheets = [];
const sheet = (name, widths, freeze) => { const sh = { name, widths, rows: [], freeze }; sheets.push(sh); return sh; };
const M = v => (v === '' || v === null || v === undefined ? '' : { v: r2(v), s: 'm' });
const F = (f, s) => ({ f, s: s || 'm' });
const B = v => ({ v, s: 'b' });
const N = v => ({ v, s: 'note' });
const H = list => list.map(v => ({ v, s: 'h' }));
const CATS = Object.values(p.sub).map(s => s.cat);
const ST = p.statusLabels;
const colName = i => { let s = ''; i += 1; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const q = s => '"' + String(s).replace(/"/g, '""') + '"';

// ---------- All Data (built first so ranges are known; placed last) ----------
const ad = { name: 'All Data', widths: [11, 13, 22, 10, 22, 42, 18, 30, 15, 13, 24, 16, 50, 14, 18, 44], rows: [], freeze: 1 };
ad.rows.push(H(['Date', 'Txn Type', 'Doc #', 'QBO Txn Id', 'Account', 'QBO Customer:Project', 'Job #', 'Production (monday)', 'Monday Group', 'Date Completed', 'Status', 'WASP Pick #', 'Description', 'Amount', 'Tie Basis', 'Key']));
const acctLabel = id => 'WIP ' + p.sub[id].cat;
for (const l of [...p.lines].sort((a, b) => a.date.localeCompare(b.date))) {
  ad.rows.push([l.date, l.type, l.doc, l.txnId, acctLabel(l.acct), l.ename, l.jobKey, l.production, l.group, l.completed, ST[l.status], l.pick, l.memo, M(l.amount), l.basis + (l.mixed ? ' | MIXED' : ''), l.key]);
}
for (const r of [...p.parentOwn].sort((a, b) => a.date.localeCompare(b.date))) {
  ad.rows.push([r.date, r.type, r.doc, r.txnId, 'WIP Parent (offset)', r.name, '', '', '', '', 'Offset', r.group.slice(0, 1), r.memo.slice(0, 150), M(r.amount), r.group, '']);
}
const nAd = ad.rows.length;
const R = c => "'All Data'!$" + c + '$2:$' + c + '$' + nAd;
const AMT = R('N'), ACC = R('E'), STC = R('K'), KEY = R('P'), GRP = R('L');

// ---------- Inventory Detail ----------
const idl = { name: 'Inventory Detail', widths: [24, 40, 20, 12, 40, 16, 16, 10, 11, 14, 14, 14], rows: [], freeze: 3 };
idl.rows.push([{ v: 'WASP inventory at ' + p.end, s: 'title' }]);
idl.rows.push([N('Source: ' + p.waspSource + '. Month-End Value = Live Value - activity after month end.')]);
idl.rows.push(H(['Item', 'Description', 'Category', 'GL Acct Id', 'GL Account', 'Site', 'Location', 'In House', 'Item Cost', 'Live Value', 'After Month End', 'Month-End Value']));
for (const it of [...p.invItems].sort((a, b) => (a.acct + a.category + a.item).localeCompare(b.acct + b.category + b.item))) {
  idl.rows.push([it.item, it.description, it.category, it.acct, (p.inv[it.acct] || {}).name || '** NO QBO ACCOUNT **', it.site, it.location, it.qty, M(it.cost), M(it.live), M(it.after), M(it.eom)]);
}
const nId = idl.rows.length;

// ---------- Summary ----------
const sum = sheet('Summary', [86, 18, 18, 18]);
const P = r => sum.rows.push(r);
const rowNo = () => sum.rows.length + 1;
P([{ v: 'WIP, COGS & INVENTORY MONTH-END - ' + p.label + ' (as of ' + p.end + ')', s: 'title' }]);
P([N('Panda Windows & Doors Operations. Run ' + p.runAt + ' PT by n8n. Blue-header columns are formulas off the All Data / Inventory Detail tabs; "QuickBooks" figures are from the QBO reports.')]);
if (p.issues.length) P([{ v: 'CANNOT POST: ' + p.issues.join('; '), s: 'wrap' }]);
P([]);
P([B('1. WIP tie-out at ' + p.end)]);
P(H(['Account', 'QuickBooks GL', 'All Data', 'Difference']));
const g0 = rowNo();
for (const [id, s] of Object.entries(p.sub)) { const r = rowNo(); P([s.name, M(p.glBal[id]), F('SUMIFS(' + AMT + ',' + ACC + ',' + q(acctLabel(id)) + ')'), F('B' + r + '-C' + r)]); }
{ const r = rowNo(); P(['Inventory Asset:Work in Process (parent) - the offset', M(p.offsetBal), F('SUMIFS(' + AMT + ',' + ACC + ',' + q('WIP Parent (offset)') + ')'), F('B' + r + '-C' + r)]); }
const g1 = rowNo() - 1;
P([B('Total Work in Process'), F('SUM(B' + g0 + ':B' + g1 + ')', 'bm'), F('SUM(C' + g0 + ':C' + g1 + ')', 'bm'), F('SUM(D' + g0 + ':D' + g1 + ')', 'bm')]);
P([]);
P([B('2. Job WIP (sub-accounts) by job status')]);
const s0 = rowNo();
for (const [k, lab] of [['OPEN', 'Jobs not completed at month end - stays in WIP (WIP tab)'], ['UNASSIGNED', 'Not tied to a Shop Updates job - stays in WIP (WIP tab)'], ['CUR', 'Completed in ' + p.label + ' - to COGS (COGS tab)'], ['PRIOR', 'Completed before ' + p.label + ', still in WIP (COGS tab)']])
  P(['   ' + lab, F('SUMIFS(' + AMT + ',' + STC + ',' + q(ST[k]) + ')')]);
const s1 = rowNo() - 1;
const tj = rowNo(); P([B('   Total job WIP'), F('SUM(B' + s0 + ':B' + s1 + ')', 'bm')]);
P(['   Difference vs GL sub-accounts (must be 0)', F('B' + tj + '-SUM(B' + g0 + ':B' + (g1 - 1) + ')', 'chk')]);
P([]);
P([B('3. Offset - parent account Inventory Asset:Work in Process (not changed by this workflow)')]);
const o0 = rowNo();
for (const g of Object.keys(p.offset).sort()) P(['   ' + g, F('SUMIFS(' + AMT + ',' + STC + ',"Offset",' + GRP + ',' + q(g.slice(0, 1)) + ')')]);
const o1 = rowNo() - 1;
P([B('   Offset balance'), F('SUM(B' + o0 + ':B' + o1 + ')', 'bm')]);
P(['   Posted to the offset in ' + p.label, M(p.offsetMonth)]);
P([]);
P([B('4. Journal entries dated ' + p.end)]);
P(H(['Entry', 'Amount', 'Doc #', 'Status']));
for (const e of p.entries) P([e.label, M(e.total), e.doc, e.already ? 'already in QuickBooks (id ' + e.already + ')' : 'posts on approval']);
if (p.priorEntry) P([p.priorEntry.label, M(p.priorEntry.total), p.priorEntry.doc, 'NOT proposed - set INCLUDE_PRIOR_COMPLETIONS = true to post']);
if (p.invEntryProposedOnly) P(['Inventory true-up to WASP', M(p.invEntryProposedOnly.total), p.invEntryProposedOnly.doc, 'shown only - not proposed (see Review)']);
if (!p.entries.length && !p.priorEntry) P(['None']);
P([]);
P([B('5. Inventory true-up - WASP vs QuickBooks at ' + p.end + ' (Inventory True-up tab)')]);
P([N(p.waspSource)]);
P(H(['Account', 'WASP', 'QuickBooks', 'WASP - QuickBooks']));
for (const r of p.invRows) { const n = rowNo(); P([r.name, F("SUMIFS('Inventory Detail'!$L$4:$L$" + nId + ",'Inventory Detail'!$D$4:$D$" + nId + ',' + q(r.id) + ')'), M(r.qbo), F('B' + n + '-C' + n)]); }
P([]);
if (p.flags.length) { P([B('Review')]); for (const f of p.flags) P([{ v: '- ' + f, s: 'wrap' }]); }

// ---------- job blocks ----------
const jobBlock = (sh, st, title) => {
  sh.rows.push([]);
  sh.rows.push([B(title)]);
  sh.rows.push(H(['Job #', 'QBO Customer:Project', 'Production (monday)', 'Monday Group', 'Date Completed', ...CATS, 'Total', 'Lines', 'Key']));
  const g = new Map();
  for (const l of p.lines) if (l.status === st) { const o = g.get(l.key) || { l, dc: '' }; o.dc = [o.dc, l.completed].sort().pop(); g.set(l.key, o); }
  const first = sh.rows.length + 1;
  const kc = colName(5 + CATS.length + 2);
  for (const [key, o] of [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const r = sh.rows.length + 1;
    sh.rows.push([o.l.jobKey || '(none)', o.l.ename, o.l.production, o.l.group, o.dc,
      ...CATS.map(c => F('SUMIFS(' + AMT + ',' + KEY + ',$' + kc + r + ',' + ACC + ',' + q('WIP ' + c) + ',' + STC + ',' + q(ST[st]) + ')')),
      F('SUM(F' + r + ':' + colName(4 + CATS.length) + r + ')'), F('COUNTIFS(' + KEY + ',$' + kc + r + ',' + STC + ',' + q(ST[st]) + ')', 'plain'), key]);
  }
  const last = sh.rows.length;
  const tr = last + 1;
  const tc = colName(5 + CATS.length);
  sh.rows.push([B('TOTAL'), '', '', '', '', ...CATS.map((c, i) => F('SUM(' + colName(5 + i) + first + ':' + colName(5 + i) + Math.max(first, last) + ')', 'bm')),
    F('SUM(' + tc + first + ':' + tc + Math.max(first, last) + ')', 'bm'), '', N('check vs All Data:'),
    F('SUMIFS(' + AMT + ',' + STC + ',' + q(ST[st]) + ')-' + tc + tr, 'chk')]);
  return tc + tr;
};
const jw = [18, 44, 30, 15, 13, ...CATS.map(() => 14), 15, 8, 40];

const wip = sheet('WIP', jw, 0);
wip.rows.push([{ v: 'WIP at ' + p.end + ' - jobs not completed at month end', s: 'title' }]);
wip.rows.push([N('Amounts are SUMIFS on All Data. Filter All Data on Status to see every transaction.')]);
jobBlock(wip, 'OPEN', 'Open jobs - stay in WIP');
jobBlock(wip, 'UNASSIGNED', 'Not tied to a Shop Updates job - left in WIP, please review');

const cg = sheet('COGS', [26, 14, 46, 14, 14, 62, 40, 12, 14, 14, 14, 15, 8, 40], 0);
cg.rows.push([{ v: 'WIP to COGS - jobs completed by ' + p.end, s: 'title' }]);
cg.rows.push([N('Job blocks are SUMIFS on All Data; journal entry lines are what will be posted on approval.')]);
const tCur = jobBlock(cg, 'CUR', 'Jobs completed in ' + p.label);
const tPri = jobBlock(cg, 'PRIOR', 'Jobs completed before ' + p.label + ' still in WIP' + (p.priorEntry ? ' (NOT proposed - INCLUDE_PRIOR_COMPLETIONS is off)' : ''));
const accName = id => { for (const s of Object.values(p.sub)) { if (s.id === id) return s.name; if (s.cogs === id) return s.cogsName; } for (const [k, a] of Object.entries(p.inv)) { if (k === id) return a.name; if (a.off === id) return a.offName; } return id; };
const jeBlock = (sh, e, status, check) => {
  sh.rows.push([]);
  sh.rows.push([B('Journal entry ' + e.doc + ' dated ' + p.end + ' - ' + status)]);
  sh.rows.push(H(['Journal No.', 'Journal Date', 'Account', 'Debits', 'Credits', 'Description', 'Name (QBO customer)', 'Customer Id']));
  const first = sh.rows.length + 1;
  for (const l of e.payload.Line) {
    const d = l.JournalEntryLineDetail, ent = d.Entity ? d.Entity.EntityRef.value : '';
    const nm = ent ? (p.lines.find(x => x.ent === ent) || {}).ename || '' : '';
    sh.rows.push([e.doc, p.end, accName(d.AccountRef.value), d.PostingType === 'Debit' ? M(l.Amount) : '', d.PostingType === 'Credit' ? M(l.Amount) : '', l.Description, nm, ent]);
  }
  const last = sh.rows.length, tr = last + 1;
  sh.rows.push([B('TOTAL'), '', '', F('SUM(D' + first + ':D' + last + ')', 'bm'), F('SUM(E' + first + ':E' + last + ')', 'bm'), N('Debits - Credits (must be 0)'), F('D' + tr + '-E' + tr, 'chk')]);
  if (check) sh.rows.push(['', '', '', '', '', N('Net to COGS vs job block (must be 0)'),
    F('SUMIFS(D' + first + ':D' + last + ',C' + first + ':C' + last + ',"Inventory Cost*")-SUMIFS(E' + first + ':E' + last + ',C' + first + ':C' + last + ',"Inventory Cost*")-' + check, 'chk')]);
};
for (const e of p.entries.filter(e => e.key !== 'INV')) jeBlock(cg, e, e.already ? 'already in QuickBooks' : 'PROPOSED, posts on approval', e.key === 'CUR' ? tCur : tPri);
if (p.priorEntry) jeBlock(cg, p.priorEntry, 'NOT proposed (INCLUDE_PRIOR_COMPLETIONS is off)', tPri);

const iv = sheet('Inventory True-up', [48, 16, 16, 16, 44, 30], 0);
iv.rows.push([{ v: 'Inventory true-up - WASP vs QuickBooks at ' + p.end, s: 'title' }]);
iv.rows.push([N(p.waspSource)]);
iv.rows.push([]);
iv.rows.push(H(['QuickBooks account', 'WASP (Inventory Detail)', 'QuickBooks', 'WASP - QuickBooks', 'True-up offset account', 'Note']));
const i0 = iv.rows.length + 1;
for (const r of p.invRows) { const n = iv.rows.length + 1; iv.rows.push([r.name, F("SUMIFS('Inventory Detail'!$L$4:$L$" + nId + ",'Inventory Detail'!$D$4:$D$" + nId + ',' + q(r.id) + ')'), M(r.qbo), F('B' + n + '-C' + n), r.offName, r.note]); }
const i1 = iv.rows.length;
iv.rows.push([B('TOTAL'), F('SUM(B' + i0 + ':B' + i1 + ')', 'bm'), F('SUM(C' + i0 + ':C' + i1 + ')', 'bm'), F('SUM(D' + i0 + ':D' + i1 + ')', 'bm')]);
{ const n = iv.rows.length + 1; iv.rows.push(['WASP on hand with no QuickBooks account', F("SUMIFS('Inventory Detail'!$L$4:$L$" + nId + ",'Inventory Detail'!$D$4:$D$" + nId + ',"")')]); }
const invE = p.entries.find(e => e.key === 'INV') || (p.invEntryProposedOnly ? Object.assign({ key: 'INV' }, p.invEntryProposedOnly) : null);
if (invE) jeBlock(iv, invE, p.entries.includes(invE) ? (invE.already ? 'already in QuickBooks' : 'PROPOSED, posts on approval') : 'shown only - not proposed', null);

sheets.push(idl);
sheets.push(ad);

// ---------- xlsx writer ----------
const C = String.fromCharCode;
const CTRL = new RegExp('[' + C(0) + '-' + C(8) + C(11) + C(12) + C(14) + '-' + C(31) + ']', 'g');
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(CTRL, '');
const SI = Object.assign({ plain: 0 }, S);
const sheetXml = sh => {
  let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
  if (sh.freeze) x += '<sheetViews><sheetView workbookViewId="0"><pane ySplit="' + sh.freeze + '" topLeftCell="A' + (sh.freeze + 1) + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  x += '<cols>' + sh.widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols><sheetData>';
  sh.rows.forEach((row, ri) => {
    x += '<row r="' + (ri + 1) + '">';
    (row || []).forEach((c, ci) => {
      if (c === '' || c === null || c === undefined) return;
      const cell = typeof c === 'object' ? c : { v: c };
      const ref = colName(ci) + (ri + 1);
      const st = cell.s ? ' s="' + SI[cell.s] + '"' : '';
      if (cell.f) x += '<c r="' + ref + '"' + st + '><f>' + xmlEsc(cell.f) + '</f></c>';
      else if (typeof cell.v === 'number' && isFinite(cell.v)) x += '<c r="' + ref + '"' + st + '><v>' + cell.v + '</v></c>';
      else x += '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(cell.v) + '</t></is></c>';
    });
    x += '</row>';
  });
  x += '</sheetData>';
  if (sh === ad) x += '<autoFilter ref="A1:P' + nAd + '"/>';
  if (sh === idl) x += '<autoFilter ref="A3:L' + nId + '"/>';
  return x + '</worksheet>';
};
const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00;&quot;-&quot;"/></numFmts>' +
  '<fonts count="5"><font><sz val="10"/><name val="Arial"/></font><font><b/><sz val="10"/><name val="Arial"/></font><font><b/><sz val="13"/><color rgb="FF1F3864"/><name val="Arial"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><i/><sz val="10"/><color rgb="FF595959"/><name val="Arial"/></font></fonts>' +
  '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2EFDA"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="9">' +
  [[0, 0, 0, ''], [0, 2, 0, ''], [0, 3, 2, '<alignment wrapText="1" vertical="center"/>'], [0, 1, 0, ''], [164, 0, 0, ''], [164, 1, 3, ''], [0, 4, 0, ''],
    [0, 0, 0, '<alignment wrapText="1" vertical="top"/>'], [164, 4, 4, '']].map(([n, f, fi, al]) => '<xf numFmtId="' + n + '" fontId="' + f + '" fillId="' + fi + '" borderId="0" xfId="0"' +
    (n ? ' applyNumberFormat="1"' : '') + (f ? ' applyFont="1"' : '') + (fi ? ' applyFill="1"' : '') + (al ? ' applyAlignment="1">' + al + '</xf>' : '/>')).join('') +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
const files = [
  ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>'],
  ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
  ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets.map((s, i) => '<sheet name="' + xmlEsc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets>' +
    (() => { const i = sheets.indexOf(ad); return '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">\'All Data\'!$A$1:$P$' + nAd + '</definedName></definedNames>'; })() +
    '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>'],
  ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
    '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
  ['xl/styles.xml', styles],
].concat(sheets.map((s, i) => ['xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s)]));

const crcTable = [];
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
const crc32 = buf => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const locals = [], central = [];
let offset = 0;
for (const [name, text] of files) {
  const raw = Buffer.from(text, 'utf8'), comp = zlib.deflateRawSync(raw), nameBuf = Buffer.from(name, 'utf8'), crc = crc32(raw);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
  locals.push(lh, nameBuf, comp); central.push(ch, nameBuf);
  offset += 30 + nameBuf.length + comp.length;
}
const cdSize = central.reduce((s, b) => s + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
const xlsx = Buffer.concat(locals.concat(central).concat([end]));
const fileName = 'WIP_COGS_Inventory_' + p.period + '.xlsx';
return [{ json: { fileName, bytes: xlsx.length, sheets: sheets.map(s => s.name) },
  binary: { workbook: { data: xlsx.toString('base64'), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName, fileExtension: 'xlsx' } } }];
