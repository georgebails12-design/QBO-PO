// One item per WASP customer name among today's moves, for the QBO lookup.
// Always at least one item so the chain keeps going (blank = no lookup).
const c = $('Build Moves').first().json.candidates;
const names = [...new Set(c.map(x => x.customerNumber).filter(Boolean))];
if (!names.length) return [{ json: { customer_number: '' } }];
return names.map(n => ({ json: { customer_number: n } }));
