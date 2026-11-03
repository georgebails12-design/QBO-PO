# WIP, COGS & inventory month-end (n8n)

n8n workflow **QBO - WIP, COGS & Inventory Month-End (approval by email)**
(id `MPMN2RoRPZGYS7PI`). The `.js` files are the Code-node sources;
`gen_workflow.py` assembles them into `workflow.js` (n8n Workflow SDK).

## Schedule
- **Weekdays 5 PM PT** – `Set Period` goes on only on the first business day of
  the month (skips weekends, New Year's Day, Labor Day) and closes the prior month.
- **Nightly 11:50 PM PT** – on the last day of the month, snapshots WASP on hand
  (In House x Item Cost) into the **WASP Month-End Inventory** data table.
- **Run Now** / **Run Snapshot Now** – manual. `MONTH_OVERRIDE` in Set Period reruns a month.

## What it does
1. Pulls the QuickBooks GL for the WIP sub-accounts and the parent
   `Inventory Asset:Work in Process` (the offset), the WIP journal-entry lines
   (customer per line), WASP picks (Daily Wasp Transactions) and Shop Updates
   completion dates (Shop Jobs Date Completed).
2. Ties every WIP line to a job and its status at month end: open, completed in the
   month, completed earlier, or not tied to a job.
3. Proposes JEs dated month end:
   - `WIPCOGS-YYYY-MM` – Dr COGS / Cr WIP per job and category for jobs completed in the month.
   - `WIPCOGS-PRIOR-YYYY-MM` – jobs completed earlier still in WIP (only if `INCLUDE_PRIOR_COMPLETIONS`).
   - `INVTRUEUP-YYYY-MM` – QuickBooks raw materials trued up to WASP at month end
     (Raw Materials vs matching COGS account; Shop Supplies vs 5381). WASP = the
     month-end snapshot, else live WASP rolled back with transactions since month
     end (flagged ESTIMATE). 1127 Capitalized Freight is report-only.
4. Emails `WIP_COGS_Inventory_YYYY-MM.xlsx` (Summary, WIP, COGS, Inventory True-up,
   Inventory Detail, All Data – totals are SUMIFS formulas on All Data), then an
   Approve / Decline email. On approve it re-checks (no duplicate DocNumber, WIP and
   raw-material balances unchanged), posts, records the moves in **WIP to COGS Moves**
   and logs the run in **WIP Month-End Close Log**.

The parent account offset is reported, never changed.
