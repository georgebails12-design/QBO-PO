# ROU lease month-end JE with email approval (n8n)

Two n8n workflows:

- **QBO - ROU Lease Month-End JE (approval by email)** (`CVnWIZUBMEfeXmpV`) runs monthly.
  It builds the lease schedules, checks QuickBooks, and emails the report with the monthly
  roll-forward workbook `ROU_Rollforward_YYYY-MM.xlsx`. A second email proposes JE
  `ROU-YYYYMM` with **Approve and post / Decline**.
- **QBO - ROU Lease Register Upload (approval by email)** (`JtgGc5AQxM18iJHa`) is a form
  for sending an edited workbook back in. Edit its Register sheet and upload it; the changes
  are emailed for approval before the register is replaced.

The month-end workflow replaces the semiannual "ROU Tie" true-up entries (12/31, 6/30) with a monthly ASC 842
operating lease entry that someone approves by email before it posts.

Baseline: *ROU Lease Workbook 2026* (12/31/2025 carryforward, same math), the Laguna Hills
3rd Amendment (6/17/2026) and the Burlingame Extension of Lease (4/15/2026). QuickBooks
already agrees with the workbook at 6/30/2026, so **July 2026 is the first month to run**.

## Monthly flow

Runs on the 5th at 7:00 PT for the previous month (after the prepaid rent amortization on the
3rd), or on demand with **Run Now**.

| Node | What it does |
| --- | --- |
| Set Period (`code/set_period.js`) | Month to close (`MONTH_OVERRIDE`), approver, `SEND_FOR_APPROVAL`, QuickBooks account ids. |
| Get Lease Register | Every row of the **ROU Lease Register** data table. |
| Get Trial Balance | QuickBooks month-end balances; 2000, 2001, 2320 and 2600 are used. |
| Get Rent GL | The month's postings to each lease's rent account(s), to check the rent was actually expensed. |
| Find Existing ROU JE | Journal entries dated the month end, to spot an `ROU-YYYYMM` already posted. |
| Build Proposal (`code/build_proposal.js`) | Lease schedules, the proposed JE, and the emails. |
| Build Workbook (`code/build_workbook.js`) | `ROU_Rollforward_YYYY-MM.xlsx` (see below). |
| Email Report and Workbook | Full report, with the workbook attached. Sent every run. |
| Email for Approval | Second email: the entry, balances and review items, with **Approve and post** / **Decline**. The link stays open 14 days. |
| Recheck Existing ROU JE, Recheck Balances, Guard Before Posting (`code/guard_post.js`) | After Approve: posts only if no `ROU-YYYYMM` exists yet and the four balances haven't moved since the email. |
| Post Journal Entry, Posted Result (`code/posted_result.js`) | Posts the JE exactly as emailed. |
| Not Approved / Report Only | Declined, expired, nothing to post, or cannot post. |
| Called by Register Upload | Lets the upload workflow re-run a month after a register change. |
| Email Result, Log Row, Save Close Log | Result email after an approval decision, and one row per run in **ROU Monthly Close Log** (`posted`, `declined`, `expired`, `blocked`, `failed`, `nothing_to_post`, `cannot_post`). |

## The entry

`ROU-YYYYMM`, dated the month end. It brings QuickBooks to the schedule:

- **2000 / 2001 / 2320 / 2600**: schedule balance less QuickBooks balance. Current liability is
  the next 12 months of principal; noncurrent is the rest.
- **Each lease's rent account**: straight-line lease expense less the rent paid. Rent itself
  stays where AP books it (or where the prepaid amortization puts it for ENTD, Noy Dori and
  Tev Tav). For those three, expense equals rent, so there is no rent line.
- **Tie-out line (6280 Rent)**: anything left over, meaning QuickBooks did not start the month
  on the schedule (an entry made outside this workflow, or a skipped month). The email
  flags it when it's $50 or more.
- Leases that have fully run off are removed from both 2000 and 2001. The first July run
  removes Burlingame's legacy 50,974.32 from both, with no P&L effect.

Run months in order. If `ROU-YYYYMM` is already posted, a rerun proposes only the remaining
difference as `ROU-YYYYMM-2`. The email checks the rent posted per lease against the lease
payment and lists differences (timing, CAM/tax, missed payments) for review. It also flags
leases ending within 3 months that have no renewal.

## The monthly roll-forward workbook

`ROU_Rollforward_YYYY-MM.xlsx`, attached to the report email every month:

| Sheet | Contents |
| --- | --- |
| Summary | QuickBooks vs schedule for 2000 / 2001 / 2320 / 2600 before and after the JE, the JE lines, review items. |
| Rollforward | This month by lease: liability BOM, remeasurement, payments, interest, EOM, current / noncurrent; gross, accumulated and net ROU, amortization, lease expense, rent found in QuickBooks. Totals with roll-forward checks. Short-term leases listed below. |
| YTD Rollforward | Each month of the year, all leases: the same liability and ROU roll-forward plus straight-line expense split into interest and amortization. |
| Schedules | Every lease month by month from January to the end of its term. |
| Register | The ROU Lease Register (payments written as `YYYY-MM: amount; ...`). |
| Instructions | How to edit the Register sheet and upload it. |

n8n Code nodes have no Excel library, so `build_workbook.js` writes the .xlsx itself
(Node's built-in zlib only).

## Updating leases from the workbook

1. Open the latest `ROU_Rollforward_YYYY-MM.xlsx` and edit the **Register** sheet. Fill in a
   rate, change a status, add a segment row for an amendment / renewal, or add a new lease.
   For a new lease, leave `opening_liability` blank: it's set to the PV of the payments.
2. Upload the file on the **ROU Lease Register Upload** form. Optionally enter a month to
   re-run (e.g. `2026-09`).
3. You get an email listing every added / changed / removed row, plus warnings, with
   **Approve and update register / Decline**. Errors are emailed instead and nothing changes.
4. Approve replaces the register. If you gave a month, the month-end runs for it and a new
   proposal email follows.

Validation (`code/upload_validate.js`) accepts months as `YYYY-MM`, dates or Excel dates,
and rates as `0.0415` or `4.15%`. It rejects duplicates, bad statuses, missing rates and
out-of-order segments. It refuses an upload that would remove more than half the register.
You can also edit the register directly in the n8n data table.

## The register: one row per lease segment

Data table `ROU Lease Register` (`sek8aEvAaYqqtY9W`); seed copy in `register_seed.json`.

| Column | Meaning |
| --- | --- |
| `lease_id`, `lease_name` | Rows with the same `lease_id` are one lease. |
| `segment` | 1 = the original lease (with opening balances); 2, 3... = renewals / amendments in date order. |
| `status` | `active`; `pending` (inputs missing, so it's not recognized yet and gets flagged every month); `short_term` (12 months or less, expensed as paid, listed for information). |
| `start_month`, `end_month` | `YYYY-MM`. Segment 1 opening balances are as of the first day of `start_month`. A later segment's `start_month` is the remeasurement month. |
| `annual_rate` | Discount rate (risk-free election), e.g. `0.0415`. |
| `payments` | Rent steps, beginning-of-month: `2026-09: 2502.70; 2027-09: 2596.32` (workbook) or JSON `[{"from":"2026-09","amount":2502.70}]` (data table). |
| `opening_liability`, `opening_net_rou`, `opening_gross_rou`, `straight_line_expense` | Segment 1 only. For a brand-new lease, set liability = net ROU = gross = PV of payments (plus IDC / less incentives) and leave expense blank to compute straight line. |
| `rent_account_id`, `rent_account_name`, `class_id` | Where the straight-line difference posts. |
| `cash_account_ids`, `cash_match` | Accounts and a regex (vendor / memo) used to find the rent QuickBooks expensed for the check. |
| `source`, `notes` | Contract reference and assumptions. |

When a segment starts, the liability is remeasured at the PV of its payments. The change
adjusts the ROU asset, and expense is reset to straight line over the rest of the term,
the same way the workbook's renewal tabs work. If the old segment had already run off
(Laguna's ran off 8/31/2026), the old gross and accumulated amortization are removed and
the asset restarts at the PV.

**To process a new amendment or renewal:** add a segment row (or a new lease) on the
workbook's Register sheet, upload it, and re-run the month it takes effect.

## Going live

Both workflows are saved but **not published**, so nothing runs on its own yet.

1. Fill in the Laguna rate (open item 1) by uploading the workbook or editing the data table.
2. Close July, August and September in order. Set `MONTH_OVERRIDE` in **Set Period** to
   `2026-07`, click **Run Now**, and approve. Repeat for `2026-08` and `2026-09`, then set it
   back to `''`. If Q3 is locked in QuickBooks, skip to October instead: the Q3 activity
   lands in October's tie-out line.
3. Publish the month-end workflow (5th of each month, 7:00 PT) and the upload workflow
   (its form URL appears once it's published).

## Open items in the seed (from the workbook's "Items to resolve")

1. **Laguna Hills renewal (segment 2) is `pending`.** It needs `annual_rate`: the risk-free
   Treasury yield for about a 3-year term at the binding date. It also needs confirmation of
   `start_month` (seeded `2026-09`) and the landlord signature (the DocuSign certificate
   shows Sent). Until then Laguna has no ROU from September on, and the email flags it.
   Estimated CAM ($619.20) is excluded as variable.
2. **Burlingame** extension 5/2026-4/2027 is set up as short-term (12 months). Treat it as a
   new lease or an extension? Is the May 1 start right?
3. **Scottsdale** ends 10/2026. Add the renewal or confirm move-out. QuickBooks shows
   $3,647.80/month paid vs $3,569.28 in the schedule.
4. **Land Rover**: no payments were found in 6291 Rent Auto / Truck. Set the right
   `rent_account_id` / `cash_account_ids`.
5. **Chicago** cost share ($750/month) is listed as short-term with a placeholder end date.
   There is no agreement on file.

## Files

- `code/*.js`: Code-node scripts, one per node.
- `build_sdk.py`: writes `workflow.sdk.ts` and `workflow_upload.sdk.ts` (n8n Workflow SDK
  source) from `code/`. Keep the scripts free of backslashes, backticks and `${` so they
  embed verbatim; the build checks this.
- `register_seed.json`: initial register rows.
- `test/test_build_proposal.js`: `node n8n/rou-lease-month-end/test/test_build_proposal.js`.
  It checks every lease against the workbook schedules (`test/workbook_2026_expected.json`)
  for Jan 2026 - Dec 2027, that entries balance, that June totals match QuickBooks after the
  6/30 tie-out, that a renewal remeasures and runs off to zero, and that a rerun after
  posting proposes nothing. It also writes the July workbook to `test/out/`.
- `test/test_upload.js`: the Register-sheet round trip. Run
  `python3 test/register_sheet_to_json.py test/out/ROU_Rollforward_2026-07.xlsx > test/out/register_rows.json`
  first. An unchanged sheet shows no changes, an edited one shows exactly the edits, and bad
  rows are rejected.
