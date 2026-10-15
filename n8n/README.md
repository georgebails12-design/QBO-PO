# Monthly sales tax by state (n8n)

`sales-tax-by-state.workflow.json` runs on the 3rd of each month at 7:00 (Pacific). It pulls the
previous month's QuickBooks invoices and emails a table of invoices, net sales, taxable sales, sales
tax and total invoiced for each state, plus a list of invoices to check before reconciling to
TaxCloud. Two CSV files are attached: the state summary and invoice-level detail.

## Setup
1. In n8n: **Workflows → Import from file** and pick `sales-tax-by-state.workflow.json`.
2. **Get Invoices** node: create a *QuickBooks Online OAuth2* credential (environment: Production).
3. **Email Report** node: connect a Gmail credential and replace `REPLACE_WITH_RECIPIENT_EMAIL`.
4. To test on a past month, set `OVERRIDE_MONTH = '2026-07'` in **Set Report Month**, click
   **Run manually**, then set it back to `''` and activate the workflow.

## How the numbers are worked out
- **State:** taken from the invoice ship-to address, then the bill-to address. Invoices with no
  state on either are grouped as `UNKNOWN` and listed in the email so they can be fixed in QuickBooks.
- **Sales tax:** "Sales Tax" line items (how invoices are entered today) plus any tax
  calculated by QuickBooks' own sales tax feature.
- **Invoices to check:** no state or an invalid state code; lines coded taxable but no tax charged
  (only in `COLLECT_STATES`, the states where tax is collected); and effective tax rates below 2%
  or above 11%. Edit these constants at the top of the **Summarize by State** code.
- **Net sales:** product and fee lines less discounts. Deposit lines and tax are left out.

`sales_tax_by_state.js` holds the same code as the **Summarize by State** node, for review.
