const fs = require('fs');
const code = fs.readFileSync(__dirname + '/../../n8n/rou-lease-month-end/code/build_proposal.js', 'utf8');
const seed = JSON.parse(fs.readFileSync(__dirname + '/../../n8n/rou-lease-month-end/register_seed.json', 'utf8'));
const accounts = { rou: { id: '1157', name: '2000' }, accum: { id: '1158', name: '2001' }, current: { id: '1160', name: '2320' }, noncurrent: { id: '1159', name: '2600' }, tieOut: { id: '788', name: '6280' } };
const run = (period, reg) => {
  const [y, m] = period.split('-').map(Number);
  const nodes = { 'Set Period': [{ period, end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), label: period, docNumber: 'ROU-' + period.replace('-', ''), sendForApproval: true, accounts }],
    'Get Lease Register': reg, 'Get Trial Balance': [{ Rows: { Row: [] } }], 'Find Existing ROU JE': [{}], 'Get Rent GL': [{}] };
  const $ = n => ({ first: () => ({ json: nodes[n][0] }), all: () => nodes[n].map(json => ({ json })) });
  return new Function('$', code)($)[0].json;
};
const out = {};
for (const rate of [null, 0.0415]) {
  const reg = seed.map(r => (rate && r.lease_id === 'LAGUNA' && r.segment === 2 ? { ...r, status: 'active', annual_rate: rate } : r));
  for (const p of ['2026-06', '2026-07', '2026-08', '2026-09']) {
    const o = run(p, reg);
    out[(rate ? 'laguna' : 'base') + '|' + p] = { target: o.target, leases: o.leases.map(l => ({ name: l.name, pay: l.pay, int: l.int, exp: l.exp, red: l.red, adj: l.adj, L: l.L, R: l.R, G: l.G, cur: l.cur })) };
  }
}
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
for (const [k, v] of Object.entries(out)) console.log(k, JSON.stringify(v.target));
