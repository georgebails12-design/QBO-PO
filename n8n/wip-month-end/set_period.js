// Month to close and run settings -- edit here.
// The schedule fires every weekday at 5 PM PT; it only goes on when today is the
// FIRST BUSINESS DAY of the month (Mon-Fri, not New Year's Day or Labor Day, which
// can fall on that day) and closes the PRIOR month. Run Now always goes on.
// MONTH_OVERRIDE = 'YYYY-MM' to run or re-run a specific month.
const MONTH_OVERRIDE = '';
// true = email the workbook, then a second email with Approve / Decline; Approve posts.
// false = report only: email the workbook, never post.
const SEND_FOR_APPROVAL = true;
const APPROVER = 'George@Panda-Windows.com';
const APPROVAL_DAYS = 10;
// Also move WIP to COGS for jobs completed BEFORE the month that still carry WIP
// (never moved). false = list them only.
const INCLUDE_PRIOR_COMPLETIONS = false;
// Inventory true-up: post QuickBooks raw-material accounts to WASP at month end.
const INCLUDE_INVENTORY_TRUEUP = true;
// Differences under this are not trued up.
const MIN_TRUEUP = 1.00;
// Live WASP rolled back to month end is an estimate; true = still propose the true-up
// (marked ESTIMATE), false = report only when there is no month-end snapshot.
const TRUEUP_FROM_LIVE_WASP = true;
// First date WIP sub-account journal entries are read from (sub-accounts started 9/2026).
const JE_START = '2026-09-01';

const tz = 'America/Los_Angeles';
const now = $now.setZone(tz);
let manual = false;
try { manual = $('Run Now').isExecuted; } catch (e) { manual = false; }

const isHoliday = d => {
  // New Year's Day (and its observed Monday), Labor Day (1st Monday of Sept).
  if (d.month === 1 && d.day === 1) return true;
  if (d.month === 1 && d.day === 2 && d.weekday === 1) return true;
  if (d.month === 9 && d.weekday === 1 && d.day <= 7) return true;
  return false;
};
const firstBizDay = d => {
  let x = d.startOf('month');
  while (x.weekday > 5 || isHoliday(x)) x = x.plus({ days: 1 });
  return x.toISODate();
};
if (!manual && !MONTH_OVERRIDE && now.toISODate() !== firstBizDay(now)) return [];

const m = MONTH_OVERRIDE
  ? DateTime.fromISO(MONTH_OVERRIDE + '-01', { zone: tz })
  : now.minus({ months: 1 }).startOf('month');
const ym = m.toFormat('yyyy-MM');
return [{ json: {
  period: ym, label: m.toFormat('MMMM yyyy'),
  start: m.toISODate(), end: m.endOf('month').toISODate(),
  nextDay: m.endOf('month').plus({ days: 1 }).toISODate(),
  docWip: 'WIPCOGS-' + ym, docPrior: 'WIPCOGS-PRIOR-' + ym, docInv: 'INVTRUEUP-' + ym,
  sendForApproval: SEND_FOR_APPROVAL, approver: APPROVER, approvalDays: APPROVAL_DAYS,
  includePrior: INCLUDE_PRIOR_COMPLETIONS, includeTrueup: INCLUDE_INVENTORY_TRUEUP,
  minTrueup: MIN_TRUEUP, trueupFromLive: TRUEUP_FROM_LIVE_WASP, jeStart: JE_START,
  runAt: now.toFormat('yyyy-MM-dd HH:mm'), manual,
} }];
