# Customer Deposits (2115) monthly reconciliation

Tracks unearned revenue by customer:job and ties it to GL account **2115 Customer Deposits** in QuickBooks Online.
This replaces the manual monthly tab in `OPERATIONS - Customer Deposit 2026.xlsx`.

## How the balance moves

Deposit invoices put money into 2115, and the final invoice takes all of it back out. Each month, for each customer:job:

| Column | Source | Tab column |
|---|---|---|
| BOM Dep | Last month's EOM | J "BOM Dep" |
| New Dep this Month | 2115 **credits** in the month (the "Deposit for Sales Order" line on deposit invoices) | L |
| Dep to Rev | 2115 **debits** in the month (the final invoice zeroes the deposit; also cancellations and credit memos) | K |
| EOM Dep | BOM + New − Dep to Rev | G "DEPOSIT" |

Total EOM must equal the 2115 balance in QB at month end (the "Variance" check on the tab).

## Verified against the workbook

| Month | BOM | New | Dep to Rev | EOM | QB 2115 | Per-job differences |
|---|---|---|---|---|---|---|
| Aug 26 | 8,370,713.28 | 933,132.73 | 2,067,411.90 | 7,236,434.11 | 7,236,434.11 at 8/31 | none (see note) |
| Sep 26 (to 9/25) | 7,236,434.11 | 1,007,399.99 | 897,737.82 | 7,346,096.28 | 7,346,096.28 at 9/25 | none |

In September, 33 jobs were final-invoiced and zeroed, with no partial releases and no negative balances. Redhawk Glass: Granton Casino took a second deposit ($21,167.08) in the same month it was final-invoiced.

Note for August: the Pettyboro Residence deposit ($264,658) was released under **Turkel Design:Turkel Systems:Pettyboro Residence**, but the tab carried it as **Turkel Design:Pettyboro Residence**. The net effect is zero. The workflow matches on the QB name, so that job moved sub-customers in QB.

After 9/25, QB also shows Desert Window Systems: Lennar 2 zeroed ($84,439.30, invoice 17526, 9/28) and a $18.32 credit memo on Sierra Pacific - CA: Fir Mountain Garage Sauna. The 2115 balance is $7,261,638.66 as of 9/28.

## n8n workflow: `QBO - Customer Deposits 2115 Monthly Rollforward`

Instance: n8n.pandawd.online, workflow `s086YQtImRva1El8`. The source is in `n8n-workflow.js`. It is read-only on QBO.

1. **Set Period**: defaults to last month. Set `MONTH_OVERRIDE` (and optionally `END_OVERRIDE`) to re-run a month or run month-to-date.
2. **Get Prior Month Balances**: last month's EOM per job, from the n8n data table `Customer Deposit Balances (2115)`.
3. **Get 2115 GL for Month**: the QBO GeneralLedger report, filtered to 2115, for the month. This is the API equivalent of the "CD Current Month GL" custom report; QBO's API cannot run saved custom reports.
4. **Get Deposit Invoices**: reads each new deposit invoice's Q number from the `Q#/Project` or `Q Number/PO #` custom field, or from `Customer PO` when that looks like a Q number.
5. **Build Deposit Rollforward**: per-job roll-forward and status (New deposit / Additional deposit / Final invoiced - deposit zeroed / Open / CHECK - …).
6. **Save Month Balances**: upserts the month into the data table, which becomes next month's BOM.
7. **Create Spreadsheet**: `Customer_Deposit_Rollforward_YYYY-MM.xlsx`, with a tie-out block (EOM vs QB 2115, BOM vs QB opening, count of CHECK rows).

It runs on the 2nd of each month at 6am ET, once activated.

### Why it rolls forward from saved balances

The full 2115 history does not work as a starting point. It opens with a $1.2M balance before 2015 and has thousands of old jobs with unreleased balances, including −$79M under no customer name. So the data table was seeded with the Aug 26 tab (175 open jobs, $7,236,434.11 = QB at 8/31), and every later month builds on the previous month's saved EOM.

### Flags to review each month

- `CHECK - partial release`: the final invoice didn't take the whole deposit.
- `CHECK - negative balance`: more was released than was on file.
- `CHECK - release with no deposit on file`: usually a job that was renamed or moved to another parent in QB.
- A blank Q Number means the deposit invoice has none in `Q#/Project`, `Q Number/PO #` or `Customer PO`. Fill it in the data table; it carries forward. For Sep 26 this was Progress Glass: Marin Art & Garden Center (tab: 91229) and Window Installation Specialists: SDCCD Student Housing (tab: 95062). Daniels Glass: Detroit Pistons Locker Room is 92529 on the invoice but 95229 on the tab.
- Stage and Production Start Day still come from the Pre Production sheet. Only Q number (new jobs) and Region (carried forward) are filled in automatically.

## `check_tab_against_gl.py`

This script checks a manually built tab against the GL, job by job:

```
python check_tab_against_gl.py "OPERATIONS - Customer Deposit 2026.xlsx" --prev "Aug 26" --cur "Sep 26" \
    --gl gl_2115.json --start 2026-09-01 --end 2026-09-25
```

`--gl` accepts the QBO GeneralLedger JSON or an .xlsx/.csv export of the "CD Current Month GL" report.
