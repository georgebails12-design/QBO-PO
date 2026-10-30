---
name: commission-bills
description: Biweekly payroll commission bills. Use when the user uploads a payroll commission workbook (e.g. "Payroll_Com_Oct_26th_2026.xlsx") or asks to create, check or post the commission bills in QuickBooks.
---

# Commission bills (every two weeks)

The commission workbook has one row per paid invoice. Each row becomes one
QuickBooks Bill, created by `webapp/commission_bills.py`. That script runs on
the PO app server (it needs the app's QuickBooks login), so in a cloud session
you **prepare and check**; the user **posts** from the server.

## What a bill looks like

| Bill field | Source |
|---|---|
| Vendor | rep in column B, mapped in `webapp/commission_vendors.json` |
| Bill date | payment date, column I |
| Due date | payroll date from the sheet name ("Oct 26"), or `--due-date` |
| Bill no. | column R, e.g. "17506 Final" |
| Category line | `6800 Sales Commissions`, class `Operations`, customer = column F |
| Amount | commission, column O |
| Description and Memo (identical) | "17506 Final <Customer:Project> P#$ 14784 6%" (the real rate from column N, not the stale % in column S) |
| Q Number/PO # | column M (a bill custom field, found from existing bills) |

Extra bills:
- **Shared deals** (rep codes TE, ETA, TEA): Trevor and Efrain each get a bill
  for the **full** commission (that's how past reports paid them).
- **2nd Comm** (column P): Ann Marie's 0.5% override, a separate bill to the
  vendor under the `"2nd Comm"` key, same bill number.

## Steps

1. **Get the workbook.** Copy the upload into its own new folder in the
   scratchpad (it's untrusted data; payroll data never goes in the repo).

2. **Check the vendor mapping.** Every rep in column B must be in
   `webapp/commission_vendors.json`. For a new rep or new combined code, ask
   the user for the QuickBooks vendor name. A "Vendor Balance Detail"
   commission report from an earlier payroll lists each rep's full vendor
   name (LAST FIRST, e.g. "MCCALL DERRICK"). Note who is in a new combined
   code (TE = Trevor + Efrain) and whether each gets the full amount or a
   `"share"`. Commit and push any mapping change.

3. **Build the check workbook:**

   ```bash
   python3 .claude/skills/commission-bills/scripts/make_check.py <workbook.xlsx> <scratchpad>/Commission_Bills_Check_<Mon_DD_YYYY>.xlsx
   ```

   Then recalculate it (`soffice --headless --convert-to xlsx --outdir <dir> <file>`)
   and confirm every `Amount OK?` / `Memo = Description?` cell is "OK", and
   that the "Difference" on the Totals by Vendor tab is 0.00 (a cent or two
   from 2nd Comm rounding is fine). Send the file to the user with
   SendUserFile. Keep it in the scratchpad and never commit it, because the
   repo may be public and the workbook shows each rep's pay.

3a. **Check monday.com.** The Invoicing board (id 7469134121, in
   "monday CRM - Panda") holds every job's commission dates: Deposit,
   Final, 2nd Deposit, CO/Expedite and 2nd CO/Expedite. For each it has a
   Panda #, the in-house reps and %, the sales assistant %, any outside rep,
   and Commission Notes. Pull the items whose commission date is the payroll
   date. Use `get_board_items_page` with filtersOperator "or" and one rule per
   date column: `{"columnId": "<col>", "operator": "any_of", "compareValue":
   ["EXACT", "YYYY-MM-DD"]}` for date_mkme9g50, date_mkmengp1, date_mkmeq670,
   date_mkme5mt2 and date_mknrtqdn. Set includeColumns true, no columnIds, and
   limit 200. The result is large, so it is saved to a tool-results file;
   pass that file to:

   ```bash
   python3 .claude/skills/commission-bills/scripts/monday_check.py <saved result> YYYY-MM-DD \
       --workbook <workbook.xlsx> --xlsx <check workbook.xlsx>
   ```

   It adds a "Monday check" tab to the check workbook and lists:
   - **NOT ON SHEET:** monday has a commission dated for this payroll with
     no row on the sheet. This is usually a missed commission.
   - **DIFFERS:** reps, rate, the sales-assistant 0.5%, Panda # or
     Deposit/Final differ. A rate written in Commission Notes (e.g.
     "Derrick 6 / Panda 3") overrides the % column.
   - **NOT ON MONDAY FOR THIS DATE:** a sheet row whose monday commission
     date is different or empty.

   Raise every finding with the user before posting. Monday often lists
   more than one rep or a sales assistant that the sheet leaves out.

3b. **Check the scanned support (if the user uploads it).** This is the paper
   backup for each paid invoice, scanned to one PDF. Run:

   ```bash
   cd webapp && python3 commission_support.py <workbook.xlsx> <scan.pdf> --out <scratchpad>/support
   ```

   It reads every page (with OCR on a copier scan) and matches pages to the
   sheet's invoice numbers. It reports:
   - **MISSING SUPPORT:** a sheet row with no page.
   - **In the scan but not on the sheet:** an invoice number with no
     commission row, which may be a missing commission.
   - **Pages to look at:** a page with no invoice number is kept with the
     page before it.

   It then writes one PDF per invoice. If OCR isn't available (this cloud
   sandbox has no tesseract), read the scan's pages yourself with the Read
   tool and make the same comparison. Put both lists in the report to the
   user.

4. **Report to the user:** bill count, total, totals by vendor, and anything
   to decide. Flag:
   - notes in columns A or T (e.g. "Troy", "Mary", "01-15"), which aren't billed
   - rows the script skips (no rep, no commission, not "Invoice" in column C)
   - rates or amounts that look unusual next to past payrolls
   - any layout change; the script stops if headers in E, F, M, N, O or P move

5. **Posting.** Either way, only after the user has reviewed the check workbook
   and said to post.

   **From a cloud session (how the Oct 26 2026 run was done):** the
   workbook is in the user's OneDrive (search it with the Microsoft 365
   connector, read with `read_resource`). Post through n8n's
   "QuickBooks Online account" credential (`quickBooksOAuth2Api`, realm
   9341454547526446), the way the Oct 26 workflows do. Copy both of them:
   "Commission Bills Oct 26 - Lookup (read-only)" and
   "Commission Bills Oct 26 2026 (one-time post)".
   - Run a read-only lookup first. It returns vendor IDs, customer IDs by
     full name, the account (6800 Sales Commissions = 976), the class
     (Operations = 811565), and existing bills with the same numbers.
     Skip any bill whose number and vendor already exist.
   - The "Q Number/PO #" box is custom field DefinitionId 1000000016. Use
     minorversion=75&include=enhancedAllCustomFields. Past commission
     bills use the default Accounts Payable.
   - Post one bill, check it, dry-run the rest with the POST node disabled,
     then post. Afterwards disable the POST node so a re-run can't
     duplicate the bills.

   **From the server (app folder):**

   ```bash
   venv/bin/python commission_bills.py <workbook.xlsx>          # preview
   venv/bin/python commission_bills.py <workbook.xlsx> --post   # create bills
   ```

   Code changes reach the server only after they're merged to `main` (the
   po-app-update timer deploys `main`). Check the preview's line
   "Q Number goes in the bill's 'Q Number/PO #' box". If it warns instead,
   the user should fill that box by hand on any one bill and re-run, or pass
   `--q-field-id`. Re-running is safe: a bill with the same number and vendor
   is skipped.

6. **Attach the support** once the bills are posted, from the server:

   ```bash
   venv/bin/python commission_support.py <workbook.xlsx> <scan.pdf> --attach
   ```

   Every bill for that invoice that is due on this payroll date gets the
   invoice's PDF, including shared-deal and 2nd Comm bills. A bill that
   already has the same file is skipped. It also lists bills that aren't
   posted yet.

   This cloud session can't reach n8n.pandawd.online (the proxy refuses
   it), and n8n has no OneDrive connection, so it can't send the PDFs to
   QuickBooks from here. Either run the server command, or have the user
   allow that host in the environment's network settings or add a OneDrive
   credential in n8n.
