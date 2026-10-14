// WASP (CloudFront) answers 429 once too many calls come in; those picks are
// fetched again, slower, after a pause. Always outputs at least one item.
const plan = $('Plan Pick Fetch').all().map(i => i.json);
const resps = $input.all().map(i => i.json);
const failed = plan.filter((p, i) => p.pick !== '__none__' && (resps[i] || {}).statusCode !== 200);
if (!failed.length) return [{ json: { pick: '__no_retry__', noRetry: true } }];
return failed.map(p => ({ json: { pick: p.pick } }));
