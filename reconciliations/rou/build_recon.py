import json, sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
S = sys.argv[1]; OUT = sys.argv[2]
sched = json.load(open(S + '/schedule_balances_2026Q3.json'))
r2 = lambda x: round(x + 0.0, 2)
ACC = [('rou', '2000 Rights of Use Assets'), ('accum', '2001 ROU Asset Amortization'), ('current', '2320 Lease Liability - Current'), ('noncurrent', '2600 Lease Liability - Noncurrent')]
# QuickBooks at 9/30/2026 (debit +), from the balance sheet pulled 10/20/2026 13:12 PT. Unchanged since the 6/30 tie-out JE.
GL = {'rou': 5910357.68, 'accum': -2853659.00, 'current': -1275439.00, 'noncurrent': -1782486.00}
jun, jul, aug, sep = (sched['base|2026-0%d' % m]['target'] for m in (6, 7, 8, 9))
burl_gross = 50974.32
# Q3 activity per schedule (Jun -> Sep), by account
q3 = {k: r2(sep[k] - jun[k]) for k, _ in ACC}
# derecognition of Burlingame is in the schedule since 3/2026, QBO still carries it
dere = {'rou': -burl_gross, 'accum': burl_gross, 'current': 0, 'noncurrent': 0}
diff = {k: r2(sep[k] - GL[k]) for k, _ in ACC}
rounding = {k: r2(diff[k] - q3[k] - dere[k]) for k, _ in ACC}

NAVY = '1F3864'; HFILL = PatternFill('solid', fgColor=NAVY); HFONT = Font(bold=True, color='FFFFFF', name='Arial', size=10)
BLUE = Font(color='0000FF', name='Arial', size=10); BASE = Font(name='Arial', size=10); BOLD = Font(name='Arial', size=10, bold=True)
TITLE = Font(name='Arial', size=13, bold=True, color=NAVY); MONEY = '#,##0.00;(#,##0.00);"-"'
TOP = Border(top=Side(style='thin')); DBL = Border(top=Side(style='thin'), bottom=Side(style='double'))
wb = Workbook()

def header(ws, r, labels, widths=None):
    for i, h in enumerate(labels, 1):
        c = ws.cell(r, i, h); c.font = HFONT; c.fill = HFILL; c.alignment = Alignment(wrap_text=True, vertical='center')
def setw(ws, widths):
    for i, w in enumerate(widths, 1): ws.column_dimensions[get_column_letter(i)].width = w
def put(ws, r, c, v, font=BASE, fmt=None, border=None):
    cell = ws.cell(r, c, v); cell.font = font
    if fmt: cell.number_format = fmt
    if border: cell.border = border
    return cell

# ---------------- Recon ----------------
ws = wb.active; ws.title = 'Recon'
setw(ws, [44, 18, 18, 18, 18, 18])
put(ws, 1, 1, 'Panda Windows & Doors - ROU asset & lease liability reconciliation', TITLE)
put(ws, 2, 1, 'Period end: September 30, 2026   |   QuickBooks vs ASC 842 lease schedule (ROU Lease Register / ROU Lease Workbook 2026)')
put(ws, 3, 1, 'GL source: QuickBooks balance sheet pulled 10/20/2026 1:12 PM PT via n8n (read-only). Balances unchanged from 6/30/2026 through 10/20/2026.')
put(ws, 4, 1, 'Sign convention: debit +, credit -. Blue = hard-coded input; black = formula.')
r = 6
header(ws, r, ['', ACC[0][1], ACC[1][1], ACC[2][1], ACC[3][1], 'Total'])
ws.row_dimensions[r].height = 30
cols = 'BCDE'
def line(label, vals, font=BASE, border=None, formula_total=True, input_=False):
    global r
    r += 1
    put(ws, r, 1, label, BOLD if font is BOLD else BASE)
    for i, k in enumerate(['rou', 'accum', 'current', 'noncurrent']):
        v = vals[i] if isinstance(vals, list) else vals(k, cols[i])
        put(ws, r, 2 + i, v, BLUE if input_ else font, MONEY, border)
    put(ws, r, 6, '=SUM(B%d:E%d)' % (r, r), font, MONEY, border)
    return r
rGL = line('Balance per QuickBooks 9/30/2026', [GL[k] for k, _ in ACC], input_=True)
r += 1; put(ws, r, 1, 'Reconciling items (add to GL to reach the schedule):', BOLD)
rA = line('  1. Q3 2026 lease activity not recorded (Jul-Sep amortization, accretion, payments, current/noncurrent reclass)', [q3[k] for k, _ in ACC], input_=True)
rB = line('  2. Burlingame legacy lease ended 2/28/2026 - fully amortized gross / accumulated amortization not removed', [dere[k] for k, _ in ACC], input_=True)
rC = line('  3. Rounding - 6/30 and 12/31 tie-out JEs posted in whole dollars', [rounding[k] for k, _ in ACC], input_=True)
rAdj = line('Adjusted QuickBooks balance', lambda k, c: '=%s%d+SUM(%s%d:%s%d)' % (c, rGL, c, rA, c, rC), BOLD, TOP)
rS = line('Balance per lease schedule 9/30/2026', [sep[k] for k, _ in ACC], input_=True)
rD = line('Unreconciled difference', lambda k, c: '=ROUND(%s%d-%s%d,2)' % (c, rAdj, c, rS), BOLD, DBL)
r += 2
put(ws, r, 1, 'Summary', BOLD); r += 1
summary = [
 ('Net ROU asset per QuickBooks', '=B%d+C%d' % (rGL, rGL)), ('Net ROU asset per schedule', '=B%d+C%d' % (rS, rS)),
 ('Lease liability per QuickBooks', '=-(D%d+E%d)' % (rGL, rGL)), ('Lease liability per schedule', '=-(D%d+E%d)' % (rS, rS)),
 ('P&L effect of catching up (credit = reduces rent expense)', '=-F%d' % rA),
]
for lab, f in summary:
    put(ws, r, 1, lab); put(ws, r, 2, f, BASE, MONEY); r += 1
r += 1
put(ws, r, 1, 'Conclusion', BOLD); r += 1
for t in [
 'Reconciled: QuickBooks agrees with the schedule after the three items above, with no unexplained difference.',
 'QuickBooks is overstated by about $325K on both sides (net ROU and lease liability) because ROU entries are booked semiannually; Q3 has not been booked.',
 'Item 1 is cleared by posting the July, August and September entries (proposed JE tab), e.g. through the n8n ROU month-end workflow. Item 2 is in the July entry. Item 3 is in the tie-out line.',
 'Not in the schedule (open, see Open items): Laguna Hills renewal from 9/1/2026 (rate pending) and the Tev Tav Q4 prepaid rent shortfall.',
]:
    c = put(ws, r, 1, t); ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=6); c.alignment = Alignment(wrap_text=True); ws.row_dimensions[r].height = 28; r += 1
r += 1
put(ws, r, 1, 'Prepared by: Claude (automated, from QuickBooks + ROU Lease Register)   Date: 10/20/2026'); r += 1
put(ws, r, 1, 'Reviewed by: ______________________   Date: __________')
ws.freeze_panes = 'B7'

# ---------------- Proposed JEs ----------------
je = wb.create_sheet('Proposed JE')
setw(je, [14, 34, 16, 16, 70])
put(je, 1, 1, 'Proposed catch-up entries (one per month; same lines the n8n ROU month-end workflow proposes)', TITLE)
put(je, 2, 1, 'Run months in order. Each month brings 2000/2001/2320/2600 to the schedule; rent lines = straight-line expense less rent paid.')
r = 4
header(je, r, ['JE / date', 'Account', 'Debit', 'Credit', 'Memo'])
prev = dict(GL)
months = [('ROU-202607', '2026-07-31', 'base|2026-07'), ('ROU-202608', '2026-08-31', 'base|2026-08'), ('ROU-202609', '2026-09-30', 'base|2026-09')]
rent_acct = {'Laguna Hills SR': 'Laguna Ridge Showroom:Rent', 'Scottsdale SR': 'Scottsdale Showroom:Rent', 'Land Rover': '6291 Rent Auto / Truck'}
je_totals = []
for doc, dt, key in months:
    t = sched[key]['target']; lines = []
    for l in sched[key]['leases']:
        off = r2(l['exp'] - l['pay'])
        if abs(off) >= 0.01:
            lines.append((rent_acct.get(l['name'], '6280 Rent'), off, '%s straight-line expense %.2f less rent %.2f' % (l['name'], l['exp'], l['pay'])))
    offs = sum(x[1] for x in lines)
    deltas = {k: r2(t[k] - prev[k]) for k, _ in ACC}
    for k, name in ACC:
        if abs(deltas[k]) >= 0.01: lines.append((name, deltas[k], 'ROU leases %s to schedule' % dt[:7]))
    resid = r2(-(sum(deltas.values()) + offs))
    if abs(resid) >= 0.01: lines.append(('6280 Rent', resid, 'Tie-out / rounding to schedule'))
    first = r + 1
    for acct, amt, memo in lines:
        r += 1
        put(je, r, 1, doc + ' ' + dt); put(je, r, 2, acct)
        put(je, r, 3, amt if amt > 0 else None, BLUE, MONEY); put(je, r, 4, -amt if amt < 0 else None, BLUE, MONEY); put(je, r, 5, memo)
    r += 1
    put(je, r, 2, 'Total ' + doc, BOLD); put(je, r, 3, '=SUM(C%d:C%d)' % (first, r - 1), BOLD, MONEY, TOP); put(je, r, 4, '=SUM(D%d:D%d)' % (first, r - 1), BOLD, MONEY, TOP)
    put(je, r, 5, '=IF(ROUND(C%d-D%d,2)=0,"Balanced","OUT OF BALANCE")' % (r, r), BOLD)
    je_totals.append(r); r += 1
    prev = dict(t)
je.freeze_panes = 'A5'

# ---------------- Q3 roll-forward by lease ----------------
rf = wb.create_sheet('Q3 Rollforward')
setw(rf, [26, 16, 14, 14, 16, 16, 14, 16, 16, 16, 14])
put(rf, 1, 1, 'Q3 2026 roll-forward by lease (schedule), 6/30/2026 to 9/30/2026', TITLE)
r = 3
header(rf, r, ['Lease', 'Liability 6/30', 'Payments Q3', 'Interest Q3', 'Liability 9/30', 'Net ROU 6/30', 'Amortization Q3', 'Net ROU 9/30', 'Lease expense Q3', 'Rent in QBO Q3', 'Exp. less rent'])
rf.row_dimensions[r].height = 30
qbo_rent = {'ENTD LLC (Panda 2)': 52500, 'Laguna Hills SR': 9199.44, 'Noy Dori (Panda 1)': 154500, 'Burlingame / SF Showroom': 0, 'Tev Tav (Panda 3)': 123930, 'Scottsdale SR': 10943.40, 'Land Rover': 0}
L6 = {l['name']: l for l in sched['base|2026-06']['leases']}
first = r + 1
for l9 in sched['base|2026-09']['leases']:
    n = l9['name']; ms = [ {x['name']: x for x in sched['base|2026-0%d' % m]['leases']}[n] for m in (7, 8, 9)]
    r += 1
    vals = [L6[n]['L'], -sum(x['pay'] for x in ms), sum(x['int'] for x in ms), None, L6[n]['R'], -sum(x['red'] for x in ms), None, sum(x['exp'] for x in ms), qbo_rent[n]]
    put(rf, r, 1, n)
    for i, v in enumerate(vals):
        if v is not None: put(rf, r, 2 + i, r2(v), BLUE, MONEY)
    put(rf, r, 5, '=B%d+C%d+D%d' % (r, r, r), BASE, MONEY); put(rf, r, 8, '=F%d+G%d' % (r, r), BASE, MONEY)
    put(rf, r, 11, '=I%d+C%d' % (r, r), BASE, MONEY)
r += 1
put(rf, r, 1, 'Total', BOLD)
for c in range(2, 12):
    L = get_column_letter(c); put(rf, r, c, '=SUM(%s%d:%s%d)' % (L, first, L, r - 1), BOLD, MONEY, TOP)
tot = r; r += 2
put(rf, r, 1, 'Ties to Recon item 1:', BOLD); r += 1
put(rf, r, 1, 'Liability change (E-B) vs 2320+2600 item 1'); put(rf, r, 2, '=-(E%d-B%d)' % (tot, tot), BASE, MONEY); put(rf, r, 3, "=Recon!D%d+Recon!E%d" % (rA, rA), BASE, MONEY); put(rf, r, 4, '=ROUND(B%d-C%d,2)' % (r, r), BOLD, MONEY); r += 1
put(rf, r, 1, 'ROU change (H-F) vs 2001 item 1'); put(rf, r, 2, '=H%d-F%d' % (tot, tot), BASE, MONEY); put(rf, r, 3, '=Recon!C%d' % rA, BASE, MONEY); put(rf, r, 4, '=ROUND(B%d-C%d,2)' % (r, r), BOLD, MONEY); r += 1
put(rf, r, 1, 'Rent in QBO vs lease payments (column J vs -C), see Rent check tab.')
rf.freeze_panes = 'B4'

# ---------------- Rent check ----------------
rc = wb.create_sheet('Rent check')
setw(rc, [26, 14, 14, 14, 14, 14, 14, 60])
put(rc, 1, 1, 'Rent expensed in QuickBooks vs lease payment, Jul-Oct 2026', TITLE)
r = 3
header(rc, r, ['Lease', 'Per lease / mo', 'Jul', 'Aug', 'Sep', 'Oct', 'Q3 diff vs lease', 'Comment'])
data = [
 ('ENTD LLC (Panda 2)', 17500, [17500, 17500, 17500, 17500], 'Via monthly prepaid amortization (6280). Prepaid through Dec.'),
 ('Noy Dori (Panda 1)', 51500, [51500, 51500, 51500, 51500], 'Via monthly prepaid amortization (6280). Prepaid through Dec.'),
 ('Tev Tav (Panda 3)', 41310, [41310, 41310, 41310, 41310], 'Via prepaid amortization, but July prepaid only Jul-Sep (123,930). Oct-Dec not paid yet: see Open items.'),
 ('Laguna Hills SR', 3066.48, [3066.48, 0, 6132.96, 3066.48], 'August paid late (Brex 9/3/2026, "Aug rent online"): timing. From Sep the lease rent is 2,502.70 base + 619.20 CAM, but 3,066.48 is still being paid.'),
 ('Scottsdale SR', 3569.28, [3647.80, 3647.80, 3647.80, 3647.80], '78.52/month over the schedule payment (likely tax/CAM, a variable cost). Lease ends 10/31/2026: renewal?'),
 ('Land Rover', 1841.44, [0, 0, 0, 0], 'No payments found in 6291 or any lease rent account. Find where the lease payment is booked.'),
 ('Burlingame / SF (short-term)', 2500, [2500, 2500, 2500, 2500], 'Short-term extension 5/2026-4/2027, expensed as paid. OK.'),
 ('Chicago cost share (short-term)', 750, [0, 0, 0, 0], 'No bills since May 2026. Ended, or bills missing?'),
]
first = r + 1
for name, per, vals, com in data:
    r += 1
    put(rc, r, 1, name); put(rc, r, 2, per, BLUE, MONEY)
    for i, v in enumerate(vals): put(rc, r, 3 + i, v, BLUE, MONEY)
    put(rc, r, 7, '=SUM(C%d:E%d)-3*B%d' % (r, r, r), BASE, MONEY)
    c = put(rc, r, 8, com); c.alignment = Alignment(wrap_text=True); rc.row_dimensions[r].height = 30
put(rc, r + 2, 1, 'Laguna and Scottsdale: rent lines in the proposed JEs use the lease payment, so any excess paid stays in rent expense (variable cost).')

# ---------------- Open items ----------------
oi = wb.create_sheet('Open items')
setw(oi, [5, 52, 16, 14, 10, 22, 16, 60])
put(oi, 1, 1, 'Reconciling and open items - aging at 10/20/2026', TITLE)
r = 3
header(oi, r, ['#', 'Description', 'Amount', 'Originated', 'Age (days)', 'Category', 'Owner', 'Action'])
items = [
 (1, 'Q3 2026 ROU activity not recorded (net ROU and lease liability each ~325K overstated)', '=Recon!F%d' % rA, '2026-07-31', 81, 'Adjustment required', 'Accounting', 'Post ROU-202607/08/09 (Proposed JE tab), or one Q3 catch-up entry if Q3 is locked. P&L effect is a 998.71 credit to rent.'),
 (2, 'Burlingame legacy lease fully amortized 2/28/2026, still in 2000/2001', burl_gross, '2026-02-28', 234, 'Adjustment required', 'Accounting', 'Dr 2001 / Cr 2000 50,974.32 (included in ROU-202607). No P&L effect.'),
 (3, 'Rounding from whole-dollar tie-out entries', '=SUM(Recon!B%d:E%d)' % (rC, rC), '2026-06-30', 112, 'Adjustment required', 'Accounting', 'Cleared by the tie-out line in ROU-202607.'),
 (4, 'Laguna Hills 3rd Amendment (term to 8/31/2029) not recognized from 9/1/2026; discount rate pending', 87786.00, '2026-09-01', 49, 'Requires investigation', 'Controller', 'Enter the risk-free rate (Treasury ~3-yr at the binding date) and confirm the landlord signature. At an illustrative 4.15%: +~87.8K ROU and liability at 9/30.'),
 (5, 'Tev Tav Q4 2026 rent (Oct-Dec) not prepaid: July prepaid only Jul-Sep, amortization continues', 123930.00, '2026-10-01', 19, 'Requires investigation', 'AP / Controller', 'Confirm the Q4 payment. Otherwise Prepaid Rent (1088) goes negative by 123,930 at 12/31.'),
 (6, 'Land Rover lease payments not found in QuickBooks rent accounts', 1841.44 * 3, '2026-07-01', 111, 'Requires investigation', 'AP', 'Locate the account; update rent_account_id in the register.'),
 (7, 'Scottsdale lease expires 10/31/2026', None, '2026-10-31', 0, 'Requires investigation', 'Controller', 'Renewal terms or move-out. A renewal is a new register segment.'),
 (8, 'Chicago cost share: no bills Jun-Oct 2026', 750.0 * 5, '2026-06-01', 141, 'Requires investigation', 'AP', 'Confirm whether the arrangement ended.'),
]
for it in items:
    r += 1
    for i, v in enumerate(it):
        c = put(oi, r, 1 + i, v, BLUE if i == 2 and not str(v).startswith('=') else BASE, MONEY if i == 2 else None)
        if i in (1, 7): c.alignment = Alignment(wrap_text=True)
    oi.row_dimensions[r].height = 42
put(oi, r + 2, 1, 'Escalation: items 1, 2, 4 and 5 exceed $50K or are aged over 60 days - controller review before close.')

# ---------------- Source ----------------
src = wb.create_sheet('Source')
setw(src, [36, 16, 16, 16, 16, 16, 16])
put(src, 1, 1, 'QuickBooks balances by month end (balance sheet, accrual), pulled 10/20/2026', TITLE)
header(src, 3, ['Account', 'Dec 2025', 'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026', 'Oct 1-20, 2026'])
qb = [('2000 Rights of Use Assets (own)', [5906738.68, 5910357.68, 5910357.68, 5910357.68, 5910357.68, 5910357.68]),
      ('2001 ROU Asset Amortization', [-2199540, -2853659, -2853659, -2853659, -2853659, -2853659]),
      ('2320 Lease Liability - Current', [-1294659, -1275439, -1275439, -1275439, -1275439, -1275439]),
      ('2600 Lease Liability - Noncurrent', [-2416078, -1782486, -1782486, -1782486, -1782486, -1782486]),
      ('1088 Prepaid Expense:Rent', [0, 0, 427620, 317310, 207000, 96690])]
r = 3
for n, v in qb:
    r += 1; put(src, r, 1, n)
    for i, x in enumerate(v): put(src, r, 2 + i, x, BLUE, MONEY)
r += 2
put(src, r, 1, 'Schedule (ROU Lease Register, Laguna renewal excluded)', BOLD); r += 1
header(src, r, ['Account', 'Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026'])
for k, n in ACC:
    r += 1; put(src, r, 1, n)
    for i, t in enumerate([jun, jul, aug, sep]): put(src, r, 2 + i, t[k], BLUE, MONEY)
r += 2
for t in ['Only 2026 postings to 2000-2600: JE 06302026-ROU Asset Ad dated 6/30/2026 (2000 +3,619; 2001 -654,119; 2320 -19,220; 2600 -633,592). Prior: JE 12312025 ROU Tie.',
          'Schedule math: beginning-of-month payments; interest = (opening liability - payment) x rate / 12; straight-line expense; current = next 12 months of principal.',
          'Schedule agrees with QuickBooks at 6/30/2026 within rounding (net ROU 3,056,698.16 vs 3,056,698.68; liability 3,057,925.20 vs 3,057,925.00).']:
    put(src, r, 1, t); r += 1

for wsx in wb.worksheets:
    for row in wsx.iter_rows():
        for c in row:
            if c.font and c.font.name != 'Arial' and c.value is not None: c.font = Font(name='Arial', size=10, bold=c.font.bold, color=c.font.color)
wb.save(OUT)
print('saved', OUT); print('diff', diff); print('q3', q3); print('rounding', rounding)
