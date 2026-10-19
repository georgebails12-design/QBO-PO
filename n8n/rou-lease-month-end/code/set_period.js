// Month to close. Default: the previous calendar month (the schedule runs on the 5th,
// after the prepaid rent amortization on the 3rd). To run or re-run a month, set
// MONTH_OVERRIDE = 'YYYY-MM'. Months must be closed in order: each month's entry trues
// QuickBooks up to the schedule, so a skipped month lands in the next month's tie-out line.
const MONTH_OVERRIDE = '';
// true  = email the proposed entry with Approve / Decline buttons; Approve posts it.
// false = report only: email the proposal, never post.
const SEND_FOR_APPROVAL = true;
const APPROVER = 'George@Panda-Windows.com';
// Days the approval link stays open. After that the run ends and nothing is posted.
const APPROVAL_DAYS = 14;

// QuickBooks accounts (ids from the chart of accounts).
const ACCOUNTS = {
  rou: { id: '1157', name: '2000 Rights of Use Assets' },
  accum: { id: '1158', name: '2001 ROU Asset Amortization' },
  current: { id: '1160', name: '2320 Lease Liability - Current' },
  noncurrent: { id: '1159', name: '2600 Lease Liability - Noncurrent' },
  // Differences between QuickBooks and the schedule that are not this month's
  // activity (entries booked outside this workflow, skipped months) go here.
  tieOut: { id: '788', name: '6280 Rent' },
};

// A month passed in by the ROU Lease Register Upload workflow (re-run after a register change) wins.
const passed = String(($input.first().json || {}).month || '').trim();
const month = /^[0-9]{4}-[0-9]{2}$/.test(passed) ? passed : MONTH_OVERRIDE;
const tz = 'America/Los_Angeles';
const m = month
  ? DateTime.fromISO(month + '-01', { zone: tz })
  : $now.setZone(tz).minus({ months: 1 }).startOf('month');
return [{ json: {
  period: m.toFormat('yyyy-MM'),
  start: m.toFormat('yyyy-MM-dd'),
  end: m.endOf('month').toFormat('yyyy-MM-dd'),
  label: m.toFormat('MMM yyyy'),
  docNumber: 'ROU-' + m.toFormat('yyyyMM'),
  sendForApproval: SEND_FOR_APPROVAL,
  approver: APPROVER,
  approvalDays: APPROVAL_DAYS,
  accounts: ACCOUNTS,
  runAt: $now.setZone(tz).toFormat('yyyy-MM-dd HH:mm'),
} }];
