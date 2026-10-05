# Prepaid 1130 month-end amortization & reconciliation (n8n)

n8n workflow **QBO - Prepaid 1130 Month-End Amortization & Recon** (`uTAzExwLD2pABK4s`).
It closes account **1130 Prepaid Expense** and every sub-account under it (Insurance, Rent,
Software, Trade Shows, and any added later).

Runs on the 3rd of each month at 6:00 for the previous month, or on demand with **Run Now**.

## Steps

| Node | What it does |
| --- | --- |
| Set Period | Month to close (`MONTH_OVERRIDE`), and `POST_JE` (default `false` = dry run). |
| Get Rollforward Rows | Last month's and this month's rows from the data table. |
| Get Accounts / Find 1130 Accounts | Finds account number 1130 and all its sub-accounts. |
| Get 1130 GL for Month / Get Trial Balance | QuickBooks General Ledger for the month and month-end Trial Balance. |
| Parse 1130 GL | Beginning balance, postings and ending balance per account; checks GL against the TB. |
| Build Rollforward | Per prepaid item: BOM + additions − straight-line amortization = EOM. |
| Save Rollforward Rows | Upserts the month into the **Prepaid Amortization Rollforward (1130)** data table. |
| Build Recon & JE | Schedule vs QuickBooks per account, and the amortization journal entry. |
| Find Existing JE / Post JE? / Post Journal Entry | Posts JE `PP1130-YYYYMM` only if `POST_JE = true` and it doesn't exist yet. |
| Format Excel Rows / Create Excel | Last step: `Prepaid_1130_Rollforward_YYYY-MM.xlsx` with recon, roll-forward, JE lines and GL detail. |

## The data table

Data table `Prepaid Amortization Rollforward (1130)` (`FkM0QGbbhz1dp1eE`) holds one row per
prepaid item per month (`period`, `item_key`). Each month's EOM becomes the next month's BOM.

- **New additions:** each bill, check or expense posted to 1130 in the month becomes an item. It gets a
  default term and expense account from `RULES` in *Build Rollforward* and is flagged `NEW` for review.
  For example, health and dental bills are expensed the following month, and rent is spread over 6 months.
- **Opening balance:** the first run creates one `SEED|<account>` row per account from the GL
  beginning balance. Set `term_months` (months left) on it, or split it into items, then re-run the month.
- **Edits:** to change a new item, edit `term_months`, `start_period` or `expense_account_id` on
  that month's row and re-run the month. For a carried item, edit `monthly_amort` on the current row
  or `remaining_months` on last month's row. `term_months = 0` expenses the whole amount in `start_period`.
- **Manual JEs:** if someone already booked amortization in QuickBooks, it's applied to unscheduled
  items first (so it's never reversed). Otherwise only the net true-up is proposed and flagged.

`workflow.sdk.ts` is the n8n Workflow SDK source. The `code/` files are the same Code-node scripts
as plain JS, so they're easier to read and diff.
