// Runs code/build_proposal.js outside n8n against the register seed and checks it
// reproduces the ROU Lease Workbook 2026 schedules, balances its entries, and leaves
// no tie-out when QuickBooks starts the month on the schedule.
//   node n8n/rou-lease-month-end/test/test_build_proposal.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const dir = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(dir, 'code', 'build_proposal.js'), 'utf8');
const seed = JSON.parse(fs.readFileSync(path.join(dir, 'register_seed.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'workbook_2026_expected.json'), 'utf8'));
const ACC = { rou: '1157', accum: '1158', current: '1160', noncurrent: '1159' };
const accounts = {
  rou: { id: '1157', name: '2000' }, accum: { id: '1158', name: '2001' }, current: { id: '1160', name: '2320' },
  noncurrent: { id: '1159', name: '2600' }, tieOut: { id: '788', name: '6280 Rent' },
};

function run(period, register, tbBalances, existing = [], glRows = []) {
  const [y, m] = period.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const nodes = {
    'Set Period': [{ period, end, label: period, docNumber: 'ROU-' + period.replace('-', ''), sendForApproval: true, accounts }],
    'Get Lease Register': register,
    'Get Trial Balance': [{ Rows: { Row: Object.entries(tbBalances).map(([id, v]) => ({ ColData: [{ id, value: id }, { value: v > 0 ? String(v) : '' }, { value: v < 0 ? String(-v) : '' }] })) } }],
    'Find Existing ROU JE': [{ QueryResponse: { JournalEntry: existing } }],
    'Get Rent GL': [{ Rows: { Row: glRows } }],
  };
  const $ = name => ({ first: () => ({ json: nodes[name][0] }), all: () => nodes[name].map(json => ({ json })) });
  return new Function('$', code)($)[0].json;
}

const close = (a, b, tol, msg) => assert.ok(Math.abs((a || 0) - (b || 0)) <= tol, msg + ': ' + a + ' vs ' + b);
const months = [];
for (let i = 0; i < 24; i++) months.push(`${2026 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);

// 1. Every lease matches the workbook, month by month (Laguna renewal still pending).
let tb = null;
for (const p of months) {
  const first = run(p, seed, {});
  if (!tb) tb = { [ACC.rou]: first.prior.rou, [ACC.accum]: first.prior.accum, [ACC.current]: first.prior.current, [ACC.noncurrent]: first.prior.noncurrent };
  const out = run(p, seed, tb);
  for (const l of out.leases) {
    const id = seed.find(r => r.lease_name === l.name).lease_id;
    const e = expected[id] && expected[id][p];
    if (!e || l.pending) continue;
    close(l.pay, e.pay, 0.005, `${id} ${p} payment`);
    close(l.int, e.int, 0.01, `${id} ${p} interest`);
    close(l.L, e.L, 0.01, `${id} ${p} liability`);
    close(l.exp, e.exp, 0.01, `${id} ${p} expense`);
    close(l.R, e.R, 0.01, `${id} ${p} net ROU`);
    if (p <= '2026-12') close(l.cur, e.cur, 0.01, `${id} ${p} current portion`);
  }
  // 2. Balanced, and with QuickBooks on last month's schedule the tie-out line is only rounding.
  assert.strictEqual(out.debits, out.credits, p + ' balanced');
  close(out.residual, 0, 0.05, p + ' tie-out');
  // QuickBooks after posting = schedule; that becomes next month's opening.
  tb = { [ACC.rou]: out.target.rou, [ACC.accum]: out.target.accum, [ACC.current]: out.target.current, [ACC.noncurrent]: out.target.noncurrent };
}

// 3. Totals at 6/30/2026 agree with what QuickBooks holds after the 6/30 tie-out JE (whole dollars).
const jun = run('2026-06', seed, {});
close(-jun.target.current, 1275439, 1, 'Jun current liability vs QBO');
close(-jun.target.noncurrent, 1782486, 1, 'Jun noncurrent liability vs QBO');
close(jun.target.rou + jun.target.accum, 5910357.68 - 2853659, 1, 'Jun net ROU vs QBO');

// 4. July from the real QuickBooks balances: Burlingame's expired gross is derecognized,
//    and the only tie-out is cents of rounding.
const jul = run('2026-07', seed, { [ACC.rou]: 5910357.68, [ACC.accum]: -2853659, [ACC.current]: -1275439, [ACC.noncurrent]: -1782486 });
assert.strictEqual(jul.debits, jul.credits);
close(jul.delta.rou, -50974.32 - 0.20, 0.02, 'July derecognizes Burlingame gross');
close(jul.residual, 0, 2, 'July tie-out is rounding only');

// 5. Laguna renewal with a rate: remeasured in Sep 2026, runs off to zero at 8/2029.
const withRate = seed.map(r => (r.lease_id === 'LAGUNA' && r.segment === 2 ? { ...r, status: 'active', annual_rate: 0.0415 } : r));
const sep = run('2026-09', withRate, {});
const lag = sep.leases.find(l => l.name === 'Laguna Hills SR');
assert.ok(!lag.pending && lag.adj > 80000 && lag.adj < 90000, 'Laguna PV of renewal ' + lag.adj);
assert.strictEqual(sep.debits, sep.credits);
const end = run('2029-08', withRate, {});
const lagEnd = end.leases.find(l => l.name === 'Laguna Hills SR');
close(lagEnd.L, 0, 0.01, 'Laguna liability at end');
close(lagEnd.R, 0, 0.01, 'Laguna ROU at end');

// 6. A second run in the same month after the JE is posted proposes nothing.
const again = run('2026-07', seed, { [ACC.rou]: jul.target.rou, [ACC.accum]: jul.target.accum, [ACC.current]: jul.target.current, [ACC.noncurrent]: jul.target.noncurrent },
  [{ Id: '1', DocNumber: 'ROU-202607' }]);
assert.strictEqual(again.payload, null, 'rerun after posting proposes nothing');

console.log('ok - July 2026 proposal:', jul.debits, 'debits;', jul.flags.length, 'flags');
for (const f of jul.flags) console.log('  -', f);

// 7. The roll-forward workbook builds from the July proposal (opened and checked by test_workbook.py).
const wbCode = fs.readFileSync(path.join(dir, 'code', 'build_workbook.js'), 'utf8');
const wbNodes = {
  'Build Proposal': [jul],
  'Set Period': [{ period: '2026-07', end: '2026-07-31', label: 'Jul 2026', docNumber: 'ROU-202607', sendForApproval: true, accounts, runAt: '2026-08-05 07:00' }],
  'Get Lease Register': seed,
};
const $wb = name => ({ first: () => ({ json: wbNodes[name][0] }), all: () => wbNodes[name].map(json => ({ json })) });
const wb = new Function('$', 'require', 'Buffer', wbCode)($wb, require, Buffer)[0];
const outFile = path.join(__dirname, 'out', wb.json.fileName);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, Buffer.from(wb.binary.workbook.data, 'base64'));
console.log('wrote', outFile, wb.json.bytes, 'bytes, sheets', wb.json.sheets.join(', '));
