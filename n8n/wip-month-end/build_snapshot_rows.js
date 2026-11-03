// WASP item list (In House x Item Cost) -> one row per item/site/location with stock.
const S = $('Snapshot Day').first().json;
const RAW = {
  'ACM': '1114', 'ALUMINUM': '1114', 'ALUM - SMALL ITEMS': '1114', 'GLASS': '1112',
  'HARDWARE SMALL PARTS': '1111', 'SPECIAL HARDWARE': '1111', 'POWDER COATING': '1113',
  'SHOP SUPPLIES': '1150040019', 'WOOD AT P2': '1121', 'FINISH': '1103',
};
const text = String($input.first().json.data || '');
if (!text.includes('AssetTag')) throw new Error('WASP inventory did not come back as CSV: ' + text.slice(0, 200));
const csv = [];
{ let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); csv.push(row); row = []; f = ''; } else if (c !== '\r') f += c; }
  if (f || row.length) { row.push(f); csv.push(row); } }
const hdr = csv.shift();
const ci = n => { const i = hdr.indexOf(n); if (i < 0) throw new Error('WASP CSV missing ' + n); return i; };
const I = { tag: ci('AssetTag'), desc: ci('AssetDescription'), cat: ci('CategoryDescription'), cost: ci('ItemCost'), qty: ci('TotalInHouse'), site: ci('SiteName'), loc: ci('LocationCode') };
const out = [];
for (const r of csv) {
  const qty = Number(r[I.qty]) || 0;
  if (!qty || !r[I.tag]) continue;
  const cat = (r[I.cat] || '').trim() || '(blank)';
  const cost = Number(r[I.cost]) || 0;
  out.push({ json: { month: S.month, taken_at: S.takenAt, item: r[I.tag], description: (r[I.desc] || '').replace(/\s+/g, ' ').trim().slice(0, 250),
    category: cat, gl_account: RAW[cat.toUpperCase()] || '', site: r[I.site] || '', location: r[I.loc] || '',
    in_house: qty, item_cost: cost, extended: Math.round(qty * cost * 100) / 100 } });
}
if (!out.length) throw new Error('WASP returned no items with stock.');
return out;
