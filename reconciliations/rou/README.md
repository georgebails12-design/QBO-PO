# ROU asset & lease liability reconciliation

`ROU_Reconciliation_2026-09.xlsx`: QuickBooks 2000 / 2001 / 2320 / 2600 vs the ASC 842 lease
schedule at 9/30/2026. It reconciles with no unexplained difference.

| Sheet | Contents |
| --- | --- |
| Recon | GL balance, three reconciling items, adjusted GL, schedule balance, difference (formulas). |
| Proposed JE | ROU-202607 / 08 / 09 catch-up entries (the same lines the n8n month-end workflow proposes). |
| Q3 Rollforward | Jun 30 to Sep 30 by lease, tied to reconciling item 1. |
| Rent check | Rent expensed in QuickBooks vs lease payment, Jul-Oct. |
| Open items | Aging, category, owner and action for each item. |
| Source | QuickBooks month-end balances and schedule balances used. |

To rebuild:

1. Run the n8n workflow **ROU Reconciliation - QBO Pull (read-only)** (`zAhaqSIoA6yFq9hk`) and
   save its Summarize output as `qbo_pull_<date>.json`.
2. `node schedule_balances.js schedule_balances_2026Q3.json`
3. `python3 build_recon.py . ROU_Reconciliation_2026-09.xlsx`

The QuickBooks figures in `build_recon.py` (`GL`, the Source sheet and the Rent check sheet)
are typed in from the pull. Update them for a new period.
