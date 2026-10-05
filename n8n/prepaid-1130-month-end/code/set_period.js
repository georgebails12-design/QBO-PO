// Month to close. Default: the previous calendar month (the schedule runs on the 3rd).
// To re-run a month, set MONTH_OVERRIDE = 'YYYY-MM'.
const MONTH_OVERRIDE = '';
// false = dry run: reconcile, update the roll-forward table and build the Excel, but do NOT post to QuickBooks.
// true  = also post the amortization journal entry (skipped if a JE with the same DocNumber already exists).
const POST_JE = false;

const tz = 'America/Los_Angeles';
const m = MONTH_OVERRIDE
  ? DateTime.fromISO(MONTH_OVERRIDE + '-01', { zone: tz })
  : $now.setZone(tz).minus({ months: 1 }).startOf('month');
return [{ json: {
  period: m.toFormat('yyyy-MM'),
  prevPeriod: m.minus({ months: 1 }).toFormat('yyyy-MM'),
  start: m.toFormat('yyyy-MM-dd'),
  end: m.endOf('month').toFormat('yyyy-MM-dd'),
  label: m.toFormat('MMM yyyy'),
  jeDoc: 'PP1130-' + m.toFormat('yyyyMM'),
  postJE: POST_JE,
} }];
