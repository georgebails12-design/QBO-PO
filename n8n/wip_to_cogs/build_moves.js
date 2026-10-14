// Picked cost per job and WIP account, less what was already moved to COGS
// (WIP to COGS Moves rows with a QBO JE id) = what to move today.
// Categories map to WIP exactly as the Daily WASP Picks to WIP JE debits them;
// Shop Supplies and unmapped categories never went to WIP and are skipped.
const S = $('Settings').first().json;
const WIP = {
  'ACM': 'AL', 'ALUMINUM': 'AL', 'GLASS': 'GL', 'HARDWARE SMALL PARTS': 'HW',
  'SPECIAL HARDWARE': 'HW', 'POWDER COATING': 'PC',
};
const ACCT = {
  AL: { wip: 'WIP Aluminum', wipId: '1150040007', cogs: 'COGS Aluminum', cogsId: '1150040013' },
  GL: { wip: 'WIP Glass', wipId: '1150040008', cogs: 'COGS Glass', cogsId: '1150040014' },
  HW: { wip: 'WIP Hardware', wipId: '1150040009', cogs: 'COGS Hardware', cogsId: '1150040015' },
  PC: { wip: 'WIP Powder Coat', wipId: '1150040011', cogs: 'COGS Powder Coat', cogsId: '1150040016' },
};
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };

const plan = $('Plan Pick Fetch').all().map(i => i.json);
const doneJobs = plan[0].doneJobs || [];
const first = $('Get Pick Transactions').all().map(i => i.json);
const retryPicks = $('Collect Failed Picks').all().map(i => i.json.pick);
const retried = {};
$input.all().forEach((i, n) => { retried[retryPicks[n]] = i.json; });

const byJob = {};
for (const j of doneJobs) byJob[j.key] = { ...j, picks: [], openPicks: [], cost: {}, notInWip: 0, custCost: {}, fetchError: false };

const seen = new Set();
const fetchErrors = [];
plan.forEach((p, idx) => {
  if (p.pick === '__none__') return;
  const J = byJob[p.job];
  J.picks.push(p.pick);
  if (p.open) J.openPicks.push(p.pick);
  let r = first[idx] || {};
  if (r.statusCode !== 200 && retried[p.pick]) r = retried[p.pick];
  const body = r.body || {};
  if (r.statusCode !== 200 || !Array.isArray(body.Data) || body.Data.length >= 5000) {
    J.fetchError = true;
    fetchErrors.push({ pick: p.pick, job: p.job, http: r.statusCode || '' });
    return;
  }
  for (const t of body.Data) {
    if (String(t.OrderNumber || '').trim() !== p.pick || t.TransTypeDescription !== 'Pick') continue;
    if (t.SortingIndex != null) { if (seen.has(t.SortingIndex)) continue; seen.add(t.SortingIndex); }
    const ext = r2(num(t.AssetTransQuantity) * num(t.AssetTransCost));
    const k = WIP[String(t.Category || '').trim().toUpperCase()];
    if (!k) { J.notInWip = r2(J.notInWip + ext); continue; }
    J.cost[k] = r2((J.cost[k] || 0) + ext);
    const c = String(t.CustomerNumber || '').trim();
    J.custCost[c] = (J.custCost[c] || 0) + ext;
  }
});

const moved = {};
const movedJobs = new Set();
for (const m of $('Get Moves So Far').all().map(i => i.json)) {
  if (!m.job || !m.qbo_je_id) continue;
  const k = m.job + '|' + m.wip_account_id;
  moved[k] = r2((moved[k] || 0) + num(m.amount));
  movedJobs.add(m.job);
}

const candidates = [];
const held = [];
for (const J of Object.values(byJob)) {
  if (J.fetchError) { held.push({ job: J.key, reason: 'WASP picks could not be pulled - retried next run' }); continue; }
  const cust = Object.entries(J.custCost).sort((a, b) => b[1] - a[1]).map(e => e[0]).find(c => c) || '';
  for (const k of Object.keys(ACCT)) {
    const a = ACCT[k];
    const picked = J.cost[k] || 0;
    const delta = r2(picked - (moved[J.key + '|' + a.wipId] || 0));
    if (Math.abs(delta) < 0.01) continue;
    candidates.push({
      job: J.key, shopItemId: J.shopItemId, jobType: J.jobType, production: J.production, completed: J.completed,
      customerNumber: cust, acct: a, picked, delta, picks: J.picks.join(', '), openPicks: J.openPicks.join(', '),
      topUp: movedJobs.has(J.key),
    });
  }
}

const flags = [];
for (const J of Object.values(byJob)) {
  const f = [];
  if (!J.picks.length) f.push('no WASP picks found');
  else if (!Object.keys(J.cost).length && !J.fetchError) f.push('picks have no WIP cost');
  if (J.openPicks.length) f.push('pick not closed in WASP: ' + J.openPicks.join(', '));
  if (f.length) flags.push({ job: J.key, production: J.production, completed: J.completed, flag: f.join('; ') });
}

return [{ json: { candidates, held, flags, fetchErrors, jobsInScope: doneJobs.length } }];
