# Daily WIP to COGS Journal Entry (n8n)

n8n workflow **Daily WIP to COGS Journal Entry** (`B3uFNcW3ypbALiJT`).
These files are the sources of its Code nodes, one file per node.

## What it does

Every day at 7 AM PT, after the 6 AM *Daily WASP Picks to WIP Journal Entry*
and the 11 PM *Shop Updates - Date Completed Sync*:

1. **Settings** (`settings.js`): `dryRun`, `startDate`, `lookbackDays`, `emailTo`.
2. **Get Shop Jobs**: reads the *Shop Jobs Date Completed* data table.
3. **Get Moves So Far**: reads the *WIP to COGS Moves* data table (what was already posted).
4. **Get WASP Pick Orders**, then **Plan Pick Fetch** (`plan_pick_fetch.js`): keeps jobs
   in the *Completed* group with Date Completed from `startDate` (or the last
   `lookbackDays`) to today, and finds their WASP picks (same pick-to-job rule as EOM Close).
5. **Get / Retry Pick Transactions** (`collect_failed.js`): pulls each pick's lines from WASP,
   with a slower retry for 429s.
6. **Build Moves** (`build_moves.js`): picked cost per job and WIP account, using the
   same category mapping the WIP JE debits (ACM/Aluminum, Glass, Hardware small parts /
   Special Hardware, Powder Coating). Subtracts what is already in *WIP to COGS Moves*.
7. **Distinct Customers** and **Lookup QBO Customer** (`distinct_customers.js`): matches
   the WASP customer name to one QBO customer the same way the WIP JE does.
8. **Build Journal Entries** (`build_journal_entries.js`): one JE per date, DocNumber
   `COGS M/D/YYYY`, Dr COGS / Cr WIP per job and category with the customer on both lines.
   A job's first move is dated its Date Completed. Picks made after that are moved on a
   later run and dated that day. Negative differences post as reversals.
9. **Should Post?**: when `dryRun` is false, the JEs are posted. **Record Moves**
   (`record_moves.js`) then writes the posted lines to *WIP to COGS Moves*.
10. **Build Summary** (`build_summary.js`) and **Email Summary**: emails what moved, what was
    held and why, and jobs to check.

| WIP account | QBO id | COGS account | QBO id |
|---|---|---|---|
| WIP Aluminum | 1150040007 | COGS Aluminum | 1150040013 |
| WIP Glass | 1150040008 | COGS Glass | 1150040014 |
| WIP Hardware | 1150040009 | COGS Hardware | 1150040015 |
| WIP Powder Coat | 1150040011 | COGS Powder Coat | 1150040016 |

## Held, never guessed

- A job whose WASP customer does not match exactly one QBO customer. The WIP JE skipped those picks too, so they never reached WIP.
- A job whose picks could not be pulled from WASP.

Held jobs are retried every day while they are inside the lookback window.
