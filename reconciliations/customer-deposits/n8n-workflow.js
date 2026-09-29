// n8n Workflow SDK source for "QBO - Customer Deposits 2115 Monthly Rollforward".
// Deployed to n8n.pandawd.online (workflow ID noted in README.md). Edit here, then push with update/create_workflow_from_code.
import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const cred = { quickBooksOAuth2Api: { id: 'sFWFYsCNN6o8AYZG', name: 'QuickBooks Online account' } };
const base = 'https://quickbooks.api.intuit.com/v3/company/9341454547526446';
const qbHeaders = { parameters: [{ name: 'Accept', value: 'application/json' }] };
const table = { __rl: true, mode: 'id', value: 'LKJqWhmmmLWnHeYf', cachedResultName: 'Customer Deposit Balances (2115)' };

const runNow = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Now' } });
const monthly = trigger({
  type: 'n8n-nodes-base.scheduleTrigger', version: 1.4,
  config: { name: '2nd of Month 6am ET', parameters: { rule: { interval: [{ field: 'months', monthsInterval: 1, triggerAtDayOfMonth: 2, triggerAtHour: 6, triggerAtMinute: 0 }] } } },
});

const setPeriod = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: {
    name: 'Set Period',
    parameters: {
      mode: 'runOnceForAllItems', language: 'javaScript',
      jsCode: `// Month to reconcile. Default: the previous calendar month (the schedule runs on the 2nd).
// To re-run a month, set MONTH_OVERRIDE = 'YYYY-MM'. To run month-to-date, also set END_OVERRIDE = 'YYYY-MM-DD'.
const MONTH_OVERRIDE = '';
const END_OVERRIDE = '';

const m = MONTH_OVERRIDE
  ? DateTime.fromISO(MONTH_OVERRIDE + '-01', { zone: 'America/New_York' })
  : $now.setZone('America/New_York').minus({ months: 1 }).startOf('month');
return [{ json: {
  period: m.toFormat('yyyy-MM'),
  prevPeriod: m.minus({ months: 1 }).toFormat('yyyy-MM'),
  start: m.toFormat('yyyy-MM-dd'),
  end: END_OVERRIDE || m.endOf('month').toFormat('yyyy-MM-dd'),
  label: m.toFormat('MMM yy'),
} }];
`,
    },
  },
});

const getPrior = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: {
    name: 'Get Prior Month Balances',
    alwaysOutputData: true, // an empty result is handled (as an error) in Build Deposit Rollforward
    parameters: {
      resource: 'row', operation: 'get', dataTableId: table, matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'period', condition: 'eq', keyValue: expr('{{ $json.prevPeriod }}') }] },
      returnAll: true,
    },
  },
});

const findAccount = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {
    name: 'Find Account 2115',
    executeOnce: true,
    parameters: {
      url: base + '/query', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true,
      queryParameters: { parameters: [
        { name: 'query', value: "select * from Account where Name = 'Customer Deposits'" },
        { name: 'minorversion', value: '75' },
      ] },
      sendHeaders: true, headerParameters: qbHeaders, options: {},
    },
    credentials: cred,
  },
});

const getGL = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {
    name: 'Get 2115 GL for Month',
    parameters: {
      url: base + '/reports/GeneralLedger', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true,
      queryParameters: { parameters: [
        { name: 'account', value: expr('{{ $json.QueryResponse.Account[0].Id }}') },
        { name: 'start_date', value: expr("{{ $('Set Period').first().json.start }}") },
        { name: 'end_date', value: expr("{{ $('Set Period').first().json.end }}") },
        { name: 'accounting_method', value: 'Accrual' },
        { name: 'columns', value: 'tx_date,txn_type,doc_num,name,memo,debt_amt,credit_amt,subt_nat_amount,rbal_nat_amount' },
        { name: 'minorversion', value: '75' },
      ] },
      sendHeaders: true, headerParameters: qbHeaders, options: {},
    },
    credentials: cred,
  },
});

const listDepositInvoices = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: {
    name: 'List Deposit Invoices',
    parameters: {
      mode: 'runOnceForAllItems', language: 'javaScript',
      jsCode: `// Invoices that credited 2115 this month, so the new jobs can pick up their Q number.
const ids = new Set();
const walk = rows => {
  for (const r of rows || []) {
    if (r.Rows) walk(r.Rows.Row);
    if (!r.ColData) continue;
    const t = r.ColData[1];
    if (t && t.value === 'Invoice' && t.id && Number(r.ColData[6].value || 0)) ids.add(t.id);
  }
};
walk($input.first().json.Rows && $input.first().json.Rows.Row);
const list = ids.size ? [...ids] : ['0'];
return [{ json: { query: "select * from Invoice where Id in ('" + list.join("','") + "') MAXRESULTS 1000" } }];
`,
    },
  },
});

const getDepositInvoices = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {
    name: 'Get Deposit Invoices',
    parameters: {
      url: base + '/query', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true,
      queryParameters: { parameters: [
        { name: 'query', value: expr('{{ $json.query }}') },
        { name: 'minorversion', value: '75' },
        { name: 'include', value: 'enhancedAllCustomFields' },
      ] },
      sendHeaders: true, headerParameters: qbHeaders, options: {},
    },
    credentials: cred,
  },
});

const build = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: {
    name: 'Build Deposit Rollforward',
    parameters: {
      mode: 'runOnceForAllItems', language: 'javaScript',
      jsCode: `// Customer deposit (unearned revenue) roll-forward by customer:job, same math as the monthly tab:
// BOM = last month's EOM (data table), New Dep = 2115 credits this month (deposit invoices),
// Dep to Rev = 2115 debits this month (the final invoice zeroes the deposit), EOM = BOM + New - Dep to Rev.
const { period, prevPeriod, start, end } = $('Set Period').first().json;
const prior = $('Get Prior Month Balances').all().map(i => i.json).filter(r => r.customer_job);
if (!prior.length) throw new Error('No balances saved for ' + prevPeriod + ' in "Customer Deposit Balances (2115)". Run that month first.');

const round = n => Math.round(n * 100) / 100;
const key = s => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
const num = s => (s ? Number(s) : 0);

let glBegin = null, glEnd = null;
const lines = [];
const walk = rows => {
  for (const r of rows || []) {
    if (r.Rows) walk(r.Rows.Row);
    if (!r.ColData) continue;
    const c = r.ColData.map(x => x.value);
    if (c[0] === 'Beginning Balance') { glBegin = num(c[8]); continue; }
    lines.push({ date: c[0], type: c[1], doc: c[2], name: c[3] || '(no name)', debit: num(c[5]), credit: num(c[6]) });
    glEnd = num(c[8]);
  }
};
const gl = $('Get 2115 GL for Month').first().json;
walk(gl.Rows && gl.Rows.Row);
if (glBegin === null) glBegin = 0;
if (glEnd === null) glEnd = glBegin;

// Q number from the deposit invoice. It is kept in different custom fields over time;
// "Customer PO" is only used when it looks like a Q number (e.g. 92799 or 90500-1).
const qByDoc = {};
for (const inv of ($input.first().json.QueryResponse || {}).Invoice || []) {
  const f = n => ((inv.CustomField || []).find(c => (c.Name || '').trim() === n) || {}).StringValue || '';
  const po = f('Customer PO');
  qByDoc[inv.DocNumber] = f('Q#/Project') || f('Q Number/PO #') || (/^\\d{5}(-\\w+)?$/.test(po) ? po : '');
}

const jobs = {};
for (const p of prior) {
  if (Math.abs(p.eom || 0) < 0.005) continue; // zeroed last month: not carried forward
  jobs[key(p.customer_job)] = { customer_job: p.customer_job, q_number: p.q_number || '', region: p.region || '',
    bom: round(p.eom), new_dep: 0, dep_to_rev: 0, dep: [], fin: [] };
}
for (const l of lines) {
  const j = jobs[key(l.name)] = jobs[key(l.name)] ||
    { customer_job: l.name, q_number: '', region: '', bom: 0, new_dep: 0, dep_to_rev: 0, dep: [], fin: [] };
  j.new_dep += l.credit; j.dep_to_rev += l.debit;
  if (l.credit) j.dep.push(l.doc);
  if (l.debit) j.fin.push(l.type === 'Credit Memo' ? 'CM ' + l.doc : l.doc);
}

const out = Object.values(jobs).map(j => {
  if (!j.q_number) j.q_number = [...new Set(j.dep.map(d => qByDoc[d]).filter(Boolean))].join(', ');
  const eom = round(j.bom + j.new_dep - j.dep_to_rev);
  let status = 'Open';
  if (eom < -0.005) status = 'CHECK - negative balance';
  else if (j.dep_to_rev && !j.bom && !j.new_dep) status = 'CHECK - release with no deposit on file';
  else if (j.dep_to_rev && Math.abs(eom) < 0.005) status = 'Final invoiced - deposit zeroed';
  else if (j.dep_to_rev) status = 'CHECK - partial release';
  else if (j.new_dep && !j.bom) status = 'New deposit';
  else if (j.new_dep) status = 'Additional deposit';
  return { period, customer_job: j.customer_job, q_number: String(j.q_number), region: j.region,
    bom: j.bom, new_dep: round(j.new_dep), dep_to_rev: round(j.dep_to_rev), eom, status,
    deposit_invoices: j.dep.join(', '), final_invoices: j.fin.join(', '),
    _glBegin: round(glBegin), _glEnd: round(glEnd), _end: end };
});
out.sort((a, b) => a.customer_job.localeCompare(b.customer_job));
return out.map(json => ({ json }));
`,
    },
  },
});

const save = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: {
    name: 'Save Month Balances',
    parameters: {
      resource: 'row', operation: 'upsert', dataTableId: table, matchType: 'allConditions',
      filters: { conditions: [
        { keyName: 'period', condition: 'eq', keyValue: expr('{{ $json.period }}') },
        { keyName: 'customer_job', condition: 'eq', keyValue: expr('{{ $json.customer_job }}') },
      ] },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          period: expr('{{ $json.period }}'), customer_job: expr('{{ $json.customer_job }}'),
          q_number: expr('{{ $json.q_number }}'), region: expr('{{ $json.region }}'),
          bom: expr('{{ $json.bom }}'), new_dep: expr('{{ $json.new_dep }}'), dep_to_rev: expr('{{ $json.dep_to_rev }}'),
          eom: expr('{{ $json.eom }}'), status: expr('{{ $json.status }}'),
          deposit_invoices: expr('{{ $json.deposit_invoices }}'), final_invoices: expr('{{ $json.final_invoices }}'),
        },
        matchingColumns: [],
        schema: [],
      },
    },
  },
});

const format = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: {
    name: 'Format Sheet with Tie-Out',
    parameters: {
      mode: 'runOnceForAllItems', language: 'javaScript',
      jsCode: `// Spreadsheet rows in the same layout as the monthly tab, plus the tie-out to QB 2115.
const rows = $input.all().map(i => i.json);
const round = n => Math.round(n * 100) / 100;
const sum = k => round(rows.reduce((s, r) => s + r[k], 0));
const t = { bom: sum('bom'), newDep: sum('new_dep'), rel: sum('dep_to_rev'), eom: sum('eom') };
const { _glBegin: glBegin, _glEnd: glEnd, _end: end } = rows[0];

const out = rows.map(r => ({
  'Customer': r.customer_job, 'Q Number': r.q_number, 'Region': r.region,
  'BOM Dep': r.bom, 'New Dep this Month': r.new_dep, 'Dep to Rev': r.dep_to_rev, 'EOM Dep': r.eom,
  'Status': r.status, 'Deposit Invoice #': r.deposit_invoices, 'Final Invoice #': r.final_invoices,
}));
const line = (label, amt) => ({ 'Customer': label, 'EOM Dep': amt });
out.push({}, line('TOTAL  (BOM / New / Dep to Rev / EOM)', t.eom));
Object.assign(out[out.length - 1], { 'BOM Dep': t.bom, 'New Dep this Month': t.newDep, 'Dep to Rev': t.rel });
out.push(
  line('QB 2115 Customer Deposits at ' + end, glEnd),
  line('Variance EOM vs QB (should be 0)', round(t.eom - glEnd)),
  line('Variance BOM vs QB opening (should be 0)', round(t.bom - glBegin)),
  line('Jobs flagged CHECK', rows.filter(r => r.status.startsWith('CHECK')).length),
);
return out.map(json => ({ json }));
`,
    },
  },
});

const toXlsx = node({
  type: 'n8n-nodes-base.convertToFile', version: 1.1,
  config: {
    name: 'Create Spreadsheet',
    parameters: {
      operation: 'xlsx', binaryPropertyName: 'data',
      options: {
        fileName: expr("Customer_Deposit_Rollforward_{{ $('Set Period').first().json.period }}.xlsx"),
        headerRow: true,
        sheetName: expr("{{ $('Set Period').first().json.label }}"),
      },
    },
  },
});

export default workflow('cd-rollforward', 'QBO - Customer Deposits 2115 Monthly Rollforward')
  .add(runNow).to(setPeriod)
  .add(monthly).to(setPeriod)
  .add(setPeriod).to(getPrior).to(findAccount).to(getGL).to(listDepositInvoices).to(getDepositInvoices).to(build)
  .add(build).to(save)
  .add(build).to(format).to(toXlsx);
