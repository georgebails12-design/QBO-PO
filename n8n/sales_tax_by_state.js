// Groups the month's QuickBooks invoices by state, totals sales and sales tax, and flags
// invoices likely to disagree with TaxCloud. Used as the "Summarize by State" Code node.
// Input: one n8n item per QuickBooks query response page ({ QueryResponse: { Invoice: [...] } }).

const num = (v) => Number(v) || 0;
const round = (v) => Math.round(v * 100) / 100;
const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(' '));
const RATE_LOW = 2, RATE_HIGH = 11; // effective tax rates (%) outside this range get flagged
// States where we collect sales tax: invoices there with taxable lines but no tax get flagged.
const COLLECT_STATES = new Set(['AZ', 'CA', 'CO', 'FL', 'NV', 'TX']);

function stateOf(inv) {
  for (const addr of [inv.ShipAddr, inv.BillAddr]) {
    if (!addr) continue;
    if (addr.CountrySubDivisionCode) return addr.CountrySubDivisionCode.trim().toUpperCase();
    // Free-form addresses: look for "City, ST 12345" in the address lines.
    const text = [addr.Line1, addr.Line2, addr.Line3, addr.Line4, addr.Line5, addr.City].filter(Boolean).join(' ');
    const m = text.match(/\b([A-Z]{2})\s+\d{5}(-\d{4})?\b/);
    if (m) return m[1];
  }
  return 'UNKNOWN';
}

function shipTo(inv) {
  const a = inv.ShipAddr?.Line1 ? inv.ShipAddr : (inv.BillAddr ?? {});
  return [a.Line1, a.Line2, a.Line3, a.City, a.CountrySubDivisionCode, a.PostalCode].filter(Boolean).join(', ').replace(/\s+/g, ' ');
}

const invoices = $input.all().flatMap((item) => item.json.QueryResponse?.Invoice ?? []);
const meta = $('Set Report Month').first().json;

const byState = {};
const unknown = [];
const detail = [];
const exceptions = [];

for (const inv of invoices) {
  const state = stateOf(inv);
  const s = (byState[state] ??= {
    state, invoices: 0, sales: 0, discounts: 0, netSales: 0, taxableSales: 0,
    salesTax: 0, depositsBilled: 0, depositsApplied: 0, totalInvoiced: 0,
  });
  let goods = 0, taxable = 0, disc = 0, tax = 0, depPos = 0, depNeg = 0;
  for (const line of inv.Line ?? []) {
    const amt = num(line.Amount);
    if (line.DetailType === 'DiscountLineDetail') { disc += amt; continue; }
    if (line.DetailType !== 'SalesItemLineDetail') continue; // skip subtotal lines
    const d = line.SalesItemLineDetail ?? {};
    const name = d.ItemRef?.name ?? '';
    if (/sales tax/i.test(name)) tax += amt;
    else if (/deposit/i.test(name)) (amt < 0 ? (depNeg += amt) : (depPos += amt));
    else {
      goods += amt;
      if (d.TaxCodeRef?.value === 'TAX') taxable += amt;
    }
  }
  // Also pick up tax calculated by QuickBooks' own sales tax engine, if any.
  tax += num(inv.TxnTaxDetail?.TotalTax);
  const net = goods - disc;
  const taxBase = Math.max(taxable - disc, 0);
  s.invoices += 1;
  s.sales += goods;
  s.discounts += disc;
  s.netSales += net;
  s.taxableSales += tax ? taxBase : 0;
  s.salesTax += tax;
  s.depositsBilled += depPos;
  s.depositsApplied += depNeg;
  s.totalInvoiced += num(inv.TotalAmt);

  const rate = tax && taxBase ? (tax / taxBase) * 100 : null;
  const base = { state, doc: inv.DocNumber, date: inv.TxnDate, customer: inv.CustomerRef?.name ?? '', shipTo: shipTo(inv) };
  const issues = [];
  if (state === 'UNKNOWN') {
    issues.push('No state on ship-to or bill-to address');
    unknown.push({ doc: inv.DocNumber, customer: base.customer, total: num(inv.TotalAmt) });
  } else if (!US_STATES.has(state)) issues.push(`"${state}" is not a US state code`);
  if (!tax && taxBase > 0 && COLLECT_STATES.has(state)) issues.push(`$${round(taxBase).toFixed(2)} of lines coded taxable but no tax charged`);
  if (rate !== null && (rate < RATE_LOW || rate > RATE_HIGH)) issues.push(`Unusual effective tax rate ${rate.toFixed(2)}%`);
  for (const issue of issues) exceptions.push({ ...base, issue, netSales: round(net), salesTax: round(tax), total: round(num(inv.TotalAmt)) });

  detail.push({
    ...base,
    type: goods === 0 && depPos > 0 ? 'Deposit invoice' : tax ? 'Taxed' : 'No tax',
    netSales: round(net), taxableSales: round(tax ? taxBase : 0), salesTax: round(tax),
    effectiveRate: rate === null ? '' : rate.toFixed(2) + '%',
    deposits: round(depPos + depNeg), total: round(num(inv.TotalAmt)), flags: issues.join('; '),
  });
}

const rows = Object.values(byState)
  .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' && k !== 'invoices' ? round(v) : v])))
  .sort((a, b) => (a.state === 'UNKNOWN') - (b.state === 'UNKNOWN') || b.netSales - a.netSales);

const totals = rows.reduce((t, r) => {
  for (const k of Object.keys(r)) if (typeof r[k] === 'number') t[k] = round((t[k] ?? 0) + r[k]);
  return t;
}, { state: 'TOTAL' });

const money = (v) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
const cell = 'padding:4px 10px;border:1px solid #ccc';
const cols = [['state', 'State'], ['invoices', 'Invoices'], ['netSales', 'Net sales'], ['taxableSales', 'Taxable sales (taxed invoices)'], ['salesTax', 'Sales tax'], ['totalInvoiced', 'Total invoiced']];
const tr = (r, tag = 'td') => '<tr>' + cols.map(([k]) => `<${tag} style="${cell};text-align:${k === 'state' ? 'left' : 'right'}">${typeof r[k] === 'number' && k !== 'invoices' ? money(r[k]) : r[k]}</${tag}>`).join('') + '</tr>';

let html = `<h2>Sales &amp; sales tax by state: ${meta.label}</h2>
<p>${invoices.length} invoices dated ${meta.startDate} to ${meta.endDate}.</p>
<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">
<tr>${cols.map(([, h]) => `<th style="${cell};background:#f2f2f2">${h}</th>`).join('')}</tr>
${rows.map((r) => tr(r)).join('\n')}
${tr(totals, 'th')}
</table>
<p style="font-size:12px;color:#555">Net sales = products and fees less discounts, before deposits and tax.
State is taken from the invoice ship-to address, then the bill-to address.</p>`;

exceptions.sort((a, b) => a.state.localeCompare(b.state) || a.date.localeCompare(b.date));
if (exceptions.length) {
  const ecols = [['doc', 'Invoice'], ['date', 'Date'], ['state', 'State'], ['customer', 'Customer'], ['issue', 'Issue'], ['salesTax', 'Tax charged'], ['total', 'Invoice total']];
  html += `<h3>Check before filing / reconciling to TaxCloud (${exceptions.length})</h3>
<p style="font-size:12px;color:#555">These invoices are the usual cause of TaxCloud mismatches: taxable lines with no tax charged, unusual tax rates, and missing or invalid states.</p>
<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">
<tr>${ecols.map(([, h]) => `<th style="${cell};background:#f2f2f2">${h}</th>`).join('')}</tr>
${exceptions.map((e) => '<tr>' + ecols.map(([k]) => `<td style="${cell};text-align:${typeof e[k] === 'number' ? 'right' : 'left'}">${typeof e[k] === 'number' ? money(e[k]) : esc(e[k])}</td>`).join('') + '</tr>').join('\n')}
</table>`;
} else {
  html += '<p><b>No exceptions found.</b></p>';
}
html += '<p style="font-size:12px;color:#555">Attached: state summary and invoice-level detail (CSV).</p>';

const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
const toCsv = (header, keys, list) => [header.map(csvCell).join(','), ...list.map((r) => keys.map((k) => csvCell(r[k])).join(','))].join('\n');
const csv = toCsv(cols.map(([, h]) => h), cols.map(([k]) => k), [...rows, totals]);
const dkeys = ['state', 'doc', 'date', 'customer', 'shipTo', 'type', 'netSales', 'taxableSales', 'salesTax', 'effectiveRate', 'deposits', 'total', 'flags'];
const detailCsv = toCsv(['State', 'Invoice', 'Date', 'Customer', 'Ship to', 'Type', 'Net sales', 'Taxable sales', 'Sales tax', 'Effective rate', 'Deposits billed(+)/applied(-)', 'Invoice total', 'Flags'], dkeys,
  detail.sort((a, b) => a.state.localeCompare(b.state) || a.date.localeCompare(b.date)));
const month = meta.startDate.slice(0, 7);

return [{ json: { month: meta.label, subject: `Sales tax by state: ${meta.label}` + (exceptions.length ? ` (${exceptions.length} to check)` : ''), html, rows, totals, unknown, exceptions },
  binary: {
    data: { data: Buffer.from(csv).toString('base64'), mimeType: 'text/csv', fileName: `sales-tax-by-state-${month}.csv` },
    detail: { data: Buffer.from(detailCsv).toString('base64'), mimeType: 'text/csv', fileName: `sales-tax-invoice-detail-${month}.csv` },
  } }];
