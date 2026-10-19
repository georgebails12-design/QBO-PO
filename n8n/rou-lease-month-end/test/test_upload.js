// Upload round trip: the Register sheet of the generated workbook loads with no changes;
// an edited sheet (Laguna renewal rate filled in, a new lease) shows exactly those changes.
//   python3 test/register_sheet_to_json.py test/out/ROU_Rollforward_2026-07.xlsx > test/out/register_rows.json
//   node test/test_upload.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const code = fs.readFileSync(path.join(__dirname, '..', 'code', 'upload_validate.js'), 'utf8');
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'register_seed.json'), 'utf8'));
const sheetRows = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', 'register_rows.json'), 'utf8'));

function run(rows, form = {}) {
  const nodes = {
    'Upload Form': [{ json: form, binary: { workbook: { fileName: 'ROU_Rollforward_2026-07.xlsx' } } }],
    'Extract Register Sheet': rows.map(json => ({ json })),
    'Get Current Register': seed.map(json => ({ json })),
  };
  const $ = name => ({ first: () => nodes[name][0], all: () => nodes[name] });
  return new Function('$', code)($)[0].json;
}

const same = run(sheetRows);
assert.deepStrictEqual(same.errors, []);
assert.strictEqual(same.changes.length, 0, 'unchanged sheet: ' + JSON.stringify(same.changes));
assert.strictEqual(same.needsApproval, false);

const edited = sheetRows.map(r => (r.lease_id === 'LAGUNA' && r.segment === 2 ? { ...r, status: 'active', annual_rate: 0.0415 } : r));
edited.push({ lease_id: 'newco', lease_name: 'New Warehouse', segment: 1, status: 'active', start_month: '11/1/2026', end_month: '2029-10',
  annual_rate: '4.10%', payments: '2026-11: 5,000.00; 2027-11: 5150', rent_account_id: '788', rent_account_name: '6280 Rent' });
const ch = run(edited, { rerun_month: '2026-09' });
assert.deepStrictEqual(ch.errors, []);
assert.strictEqual(ch.changes.length, 2, JSON.stringify(ch.changes, null, 1));
assert.ok(ch.changes.some(c => c.type === 'changed' && /status: pending -> active; annual_rate: \(blank\) -> 0.0415/.test(c.text)));
const nw = ch.rows.find(r => r.lease_id === 'NEWCO');
assert.strictEqual(nw.start_month, '2026-11');
assert.ok(Math.abs(nw.annual_rate - 0.041) < 1e-9);
assert.ok(nw.opening_liability > 170000 && nw.opening_liability < 175000, 'PV ' + nw.opening_liability);
assert.strictEqual(ch.rerunMonth, '2026-09');
assert.ok(ch.needsApproval);

const bad = run(sheetRows.map(r => (r.lease_id === 'ENTD' ? { ...r, status: 'maybe', end_month: '2020-01' } : r)));
assert.ok(!bad.valid && bad.errors.length >= 2, JSON.stringify(bad.errors));
assert.ok(!run([]).valid);
console.log('ok - upload round trip;', ch.changes.map(c => c.type + ' ' + c.key).join(', '));
