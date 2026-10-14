// Shop Jobs Date Completed rows + WASP pick orders -> which picks to pull.
// A job is in scope when it is in the Completed group with Date Completed
// between Settings.from and today. Output: one item per pick of those jobs;
// the first item also carries the in-scope jobs.
const S = $('Settings').first().json;
const PT = 'America/Los_Angeles';
const ptDate = v => {
  if (!v) return '';
  const d = DateTime.fromISO(String(v), { zone: 'utc' });
  return d.isValid ? d.setZone(PT).toISODate() : String(v).slice(0, 10);
};

const rows = $('Get Shop Jobs').all().map(i => i.json).filter(r => r.job);
if (rows.length < 100) throw new Error('Only ' + rows.length + ' rows in Shop Jobs Date Completed - did the nightly sync fail?');

const jobs = rows.map(r => ({
  shopItemId: String(r.shop_item_id || ''), job: String(r.job), key: String(r.job).split('/')[0].trim(),
  jobType: r.job_type || '', group: r.group_name || '', production: r.production_name || '',
  customer: r.customer || '', completed: ptDate(r.date_completed),
}));
const done = jobs.filter(j => j.group === 'Completed' && j.completed && j.completed >= S.from && j.completed <= S.today);
const doneKeys = new Set(done.map(j => j.key));

const status = {};
for (const page of $('Get WASP Pick Orders').all())
  for (const h of (page.json.Data || [])) if (h.PickOrderNumber) status[h.PickOrderNumber] = h.OrderStatus || '';
if (!Object.keys(status).length) throw new Error('No pick orders came back from WASP - check the WASP API Token credential.');

// A pick belongs to a job when its number equals the job's, or starts with it
// followed by a non-digit ("89139.1", "88754S", "81492-PHASE 2"); punctuation is
// ignored ("66494-S1" == "66494-S.1"). Longest job wins. Same rule as EOM Close.
const norm = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const byPrefix = {};
for (const k of new Set(jobs.map(j => j.key))) {
  const n = norm(k);
  if (n.length < 3) continue;
  (byPrefix[n.slice(0, 3)] = byPrefix[n.slice(0, 3)] || []).push([k, n]);
}
for (const list of Object.values(byPrefix)) list.sort((a, b) => b[1].length - a[1].length);
const jobOf = p => {
  const np = norm(p);
  for (const [k, nk] of byPrefix[np.slice(0, 3)] || []) {
    if (np === nk || (np.startsWith(nk) && !/\d/.test(np[nk.length]))) return k;
    if (p.toUpperCase().startsWith(k.toUpperCase()) && !/\d/.test(p.charAt(k.length))) return k;
  }
  return '';
};

const out = [];
for (const [pick, st] of Object.entries(status)) {
  const job = jobOf(pick);
  if (doneKeys.has(job)) out.push({ pick, job, status: st, open: !st.startsWith('Closed') });
}
out.sort((a, b) => a.pick.localeCompare(b.pick));
if (!out.length) out.push({ pick: '__none__', job: '', status: '', open: false });
out[0].doneJobs = done;
return out.map(j => ({ json: j }));
