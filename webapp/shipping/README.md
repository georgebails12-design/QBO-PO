# Shipping Calculator

Upload a Panda Sales Order (PDF, JPG or PNG), check what was read off it, and
get the proposed shipping + crating price side by side with what the order
currently charges. Implements the **v2 shipping pricing proposal** (LTL /
dedicated truck / flatbed mode selection; Hawaii, Alaska and Canada pricing
that scales with order size).

- **Live:** `https://po.pandawd.online/shipping/` (same login as the PO app; "Shipping Calculator" in the top menu)
- **Offline:** open `webapp/shipping/index.html` straight from a checkout. It runs entirely
  in the browser; nothing is uploaded anywhere. It needs internet only to load
  the PDF reader (pdf.js) and image OCR (tesseract.js) from cdnjs.

## Files

| File | What's in it | Change it when… |
|---|---|---|
| `pricing.js` | **The formula.** Every rate, threshold, distance band and state/province distance lives in `RATES` / `STATE_DISTANCE` / `CANADA_DISTANCE` at the top. | Pricing changes. |
| `parser.js` | Reads Sales Order text: ship-to, door/window counts, dimensions, crates, printed charges. Also the confidence checks. | Sales Order layout changes, or a field is misread. |
| `app.js` | Page behaviour (upload, review form, results). No pricing logic. | UI changes. |
| `index.html`, `style.css` | Markup and styling. | UI changes. |
| `test/pricing.test.js` | Tests, including the worked examples from the proposal. | Always, alongside any of the above. |

## Changing pricing

1. Edit the number in `RATES` in `pricing.js`.
2. Bump `FORMULA_VERSION` (shown on every result and in the copied summary, so
   a quote can be traced to the formula that produced it).
3. Update the formula section below.
4. Run the tests and fix any expected values the change is *meant* to move:
   ```bash
   node --test webapp/shipping/test/pricing.test.js
   ```
   Node 18+ only; there is nothing to install.
5. Open a PR. Merging to `main` redeploys the PO app automatically (deploy/po-app-update.sh).

## The formula (Shipping Model v2.1)

```
d       = one-way road miles, Las Vegas (89030) to ship-to (per-state estimate)
n_d,n_w = door count, window count
crates  = door crates + window crates + track crates

Hawaii:  4800 + 420*n_d^0.75 + 270*n_w^0.75     (x1.2 if oversize)
Alaska:  4200 + 380*n_d^0.75 + 240*n_w^0.75     (x1.2 if oversize)

Otherwise pick a mode:
  flatbed    if crate height > 100" or crate length > 280"
  dedicated  else if crates >= 6 or n_d + n_w >= 12
  ltl        otherwise

  flatbed:   max(1900, 3.20*d) + 350
  dedicated: max(1600, 2.60*d)
  ltl:       max(1200, (band(d) + 280*n_d^0.75 + 180*n_w^0.75) * (1.25 if oversize))

Canada: add max(400, 25% of the price above)
```

**LTL distance bands:** 0–150 mi $750 · 151–300 $1,050 · 301–500 $1,300 ·
501–750 $1,500 · 751–1,000 $1,700 · 1,001–1,500 $1,950 · 1,501–2,000 $2,200 ·
2,001–2,500 $2,450 · 2,501–3,000 $2,650 · 3,001+ $2,650 + $150 per additional 250 mi.

**Oversize** (Panda's existing flag): any unit with a frame dimension over 100"
or over 40 sqft. A surcharge for units that still fit an enclosed trailer;
separate from the flatbed trigger.

**Crating** (unchanged from today): 8 doors per crate, 10 windows per crate,
$480 per door or window crate, plus a $300 track crate per door crate on lines
that mention track. Line items are not combined into shared crates.
Unrecognised lines are crated as doors.

**Crate size:** largest panel width and height on the order, +10" on every
side; the larger padded side is the length, the smaller the height, width is
fixed at 45". This feeds the flatbed trigger.

**Old-vs-new comparison:** uses the shipping and crating printed on the Sales
Order when found. Otherwise the legacy formula (table 301 f(d) × table 303,
weight estimated from area) is computed for comparison.

## Open questions

- **Flatbed minimum.** The calculator charges `max(1900, 3.20*d) + 350`; the
  proposal PDF's pseudocode says `max(1900, 3.20*d + 350)`. They give different
  prices for flatbed runs under about 594 mi (e.g. 100 mi: $2,250 vs $1,900).
  The calculator's behaviour is kept for now. To switch to the PDF's version,
  set `RATES.flatbed.minimumIncludesHandling = true` and update the
  `dedicated and flatbed pricing` test.
- **Per-line tapering.** The proposal says door/window counts are "counted per
  line item" before the ^0.75 taper; the calculator tapers the order totals.
  The proposal's worked examples are all single-line orders, so they don't
  distinguish the two.
- **Distances** are one number per state/province, not per ZIP. Large states
  (CA, TX) can be far off for a specific address.
- Crate counts assume line items aren't combined into shared crates, and that
  oversize applies to the whole shipment. Both still need business sign-off.
