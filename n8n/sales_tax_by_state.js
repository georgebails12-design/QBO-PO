// Groups the month's QuickBooks invoices by state and totals sales and sales tax.
// Used as the "Summarize by State" Code node in sales-tax-by-state.workflow.json.
// Input: one n8n item per QuickBooks query response page ({ QueryResponse: { Invoice: [...] } }).

const num = (v) => Number(v) || 0;
const round = (v) => Math.round(v * 100) / 100;

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

const invoices = $input.all().flatMap((item) => item.json.QueryResponse?.Invoice ?? []);
const meta = $('Set Report Month').first().json;

const byState = {};
const unknown = [];

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
  s.invoices += 1;
  s.sales += goods;
  s.discounts += disc;
  s.netSales += net;
  s.taxableSales += tax ? Math.max(taxable - disc, 0) : 0;
  s.salesTax += tax;
  s.depositsBilled += depPos;
  s.depositsApplied += depNeg;
  s.totalInvoiced += num(inv.TotalAmt);
  if (state === 'UNKNOWN') unknown.push({ doc: inv.DocNumber, customer: inv.CustomerRef?.name, total: num(inv.TotalAmt) });
}

const rows = Object.values(byState)
  .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' && k !== 'invoices' ? round(v) : v])))
  .sort((a, b) => (a.state === 'UNKNOWN') - (b.state === 'UNKNOWN') || b.netSales - a.netSales);

const totals = rows.reduce((t, r) => {
  for (const k of Object.keys(r)) if (typeof r[k] === 'number') t[k] = round((t[k] ?? 0) + r[k]);
  return t;
}, { state: 'TOTAL' });

const money = (v) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const cols = [['state', 'State'], ['invoices', 'Invoices'], ['netSales', 'Net sales'], ['taxableSales', 'Taxable sales (taxed invoices)'], ['salesTax', 'Sales tax'], ['totalInvoiced', 'Total invoiced']];
const tr = (r, tag = 'td') => '<tr>' + cols.map(([k]) => `<${tag} style="padding:4px 10px;border:1px solid #ccc;text-align:${k === 'state' ? 'left' : 'right'}">${typeof r[k] === 'number' && k !== 'invoices' ? money(r[k]) : r[k]}</${tag}>`).join('') + '</tr>';

let html = `<h2>Sales &amp; sales tax by state: ${meta.label}</h2>
<p>${invoices.length} invoices dated ${meta.startDate} to ${meta.endDate}.</p>
<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">
<tr>${cols.map(([, h]) => `<th style="padding:4px 10px;border:1px solid #ccc;background:#f2f2f2">${h}</th>`).join('')}</tr>
${rows.map((r) => tr(r)).join('\n')}
${tr(totals, 'th')}
</table>
<p style="font-size:12px;color:#555">Net sales = products and fees less discounts, before deposits and tax.
State is taken from the invoice ship-to address, then the bill-to address.</p>`;
if (unknown.length) {
  html += `<p><b>${unknown.length} invoice(s) have no state on the ship-to or bill-to address. Please fix these in QuickBooks:</b></p><ul>` +
    unknown.map((u) => `<li>#${u.doc}: ${u.customer} (${money(u.total)})</li>`).join('') + '</ul>';
}

const csv = [cols.map(([, h]) => h).join(','), ...[...rows, totals].map((r) => cols.map(([k]) => r[k]).join(','))].join('\n');

return [{ json: { month: meta.label, subject: `Sales tax by state: ${meta.label}`, html, rows, totals, unknown },
  binary: { data: { data: Buffer.from(csv).toString('base64'), mimeType: 'text/csv', fileName: `sales-tax-by-state-${meta.startDate.slice(0, 7)}.csv` } } }];
