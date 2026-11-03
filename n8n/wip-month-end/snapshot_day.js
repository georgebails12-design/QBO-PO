// Month-end WASP snapshot: the schedule fires every night at 11:50 PM PT and goes on
// only on the last day of the month, so the true-up uses WASP as of month end.
// Run Snapshot Now takes one immediately (labelled with the current month).
const tz = 'America/Los_Angeles';
const now = $now.setZone(tz);
let manual = false;
try { manual = $('Run Snapshot Now').isExecuted; } catch (e) { manual = false; }
if (!manual && now.plus({ days: 1 }).day !== 1) return [];
return [{ json: { month: now.toFormat('yyyy-MM'), takenAt: now.toFormat('yyyy-MM-dd HH:mm') } }];
