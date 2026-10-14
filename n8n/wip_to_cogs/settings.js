// Run settings -- edit here.
// dryRun: true = build the entries and email them, do NOT post to QuickBooks.
// startDate: jobs completed before this date are never moved (earlier months
//   are handled by the month-end close).
// lookbackDays: jobs completed this many days back are re-checked each day, so
//   picks made after a job was moved are moved too (or reversed if negative).
const dryRun = true;
const startDate = '2026-10-01';
const lookbackDays = 30;
const emailTo = 'George@Panda-Windows.com';

const now = DateTime.now().setZone('America/Los_Angeles');
const today = now.toISODate();
const back = now.minus({ days: lookbackDays }).toISODate();
return [{ json: {
  dryRun, startDate, lookbackDays, emailTo, today,
  from: back < startDate ? startDate : back,
  runAt: now.toFormat('yyyy-MM-dd HH:mm'),
} }];
