# CenterPoint `Configurable##` Field Legend

CenterPoint's XML export stores most of the business-meaningful per-quote data as generically
named `Configurable01`...`Configurable44` fields inside the escaped
`quoteheader` → `QuoteHeaderXML/QuoteHeaderData/QuoteHeader` block. There is no shipped legend —
each meaning below was inferred by comparing values against the matching QBO estimate's known
custom fields (see `qbo_custom_fields.md`). Only two examples have been decoded so far
(Quote_4086_export.xml / QBO 11172, and Quote_2447_export.xml / QBO 11152) — treat "confirmed"
entries as solid and "guess" entries as needing another data point before relying on them.

| Field | Meaning | Confidence | Evidence |
|---|---|---|---|
| `Configurable02` (== root `block`) | Residential or Commercial type | **Confirmed** | Exact match to QBO "Residential or Commercial" custom field on both examples (minor punctuation difference: CenterPoint uses `"Residential - Single Family"`, QBO uses `"Residential -Single Family"`). |
| `Configurable07` | RSM (full name) | **Confirmed** | "Sean Torre" → QBO RSM "Sean" (11172); "Efrain Zarate" → QBO RSM "Efrain" (11152). QBO keeps first name only. |
| `Configurable27` | Deposit schedule (e.g. `"50/50"`) | **Confirmed** | QBO Deposit Due was exactly 50% of the total on both examples, consistent with a 50/50 split. Not a dollar amount — compute Deposit Due as `total * (first number / 100)`. |
| `Configurable17` | Crating fee amount | **Confirmed, exact** | Matched the QBO "Crating Fee" line item to the cent on both examples ($480.00, $1,080.00) — passes through unmarked-up. |
| `Configurable11` | Crating type label (e.g. `"Standard Crating"`) | **Confirmed (descriptive)** | Accompanies Configurable17; not itself a QBO field, just context. |
| `Configurable15` | Freight/shipping estimate | **Partial / approximate** | Close to QBO's Shipping Fee line for 11152 ($2,483.14 vs $2,484.94, ~$1.80 off — plausible rounding or fuel-surcharge drift) but noticeably off for 11172 ($1,320.00 vs $1,765.00, ~$445 / 34% off). Don't treat this as an exact source for the QBO shipping line — treat it as a starting estimate that may get revised before the estimate is finalized. |
| `Configurable03` (== root `model`) | Delivery method (`"Shipping"` in both examples) | Confirmed value, no QBO mapping | Always "Shipping" so far; no corresponding QBO custom field found. |
| `Configurable09` | Possibly end-customer type (`"Homeowner"` / `"Glazing Company"`) | **Guess** | No confirmed QBO counterpart. Plausible reading based on the values seen, not verified against a QBO field. |
| `Configurable08` | Possibly sales territory/region (`"West - Residential"` / `"Southwest"`) | **Guess** | No confirmed QBO counterpart. |
| `Configurable04` | Unclear (`"Other"` / `"Dealer/Partner"`) | **Unreliable** | Does NOT correlate with whether a Dealer was actually set in QBO (both examples had a Dealer set in QBO despite different Configurable04 values) — don't use this as a dealer-vs-direct flag until clarified. |

## Open questions (ask a human, don't guess further)

- Where does the per-dealer markup percentage actually live? It's not in this XML
  (`dealermarkuppct` / `MarkupPctSetByConfigurator` are 0 in both examples) — the markup is
  applied somewhere outside the CenterPoint export, most likely when the QBO estimate itself is
  built.
- What do `Configurable04`, `Configurable08`, and `Configurable09` actually represent? Confirm
  with whoever configured the CenterPoint field labels rather than continuing to infer from
  values alone.

## Extending this file

When a new CenterPoint/QBO pair gets decoded, add its evidence to the relevant row (or add a new
row) rather than starting a fresh mapping document — the value of this file is in accumulating
confirmed evidence across quotes, since a single example can't distinguish a real mapping from
coincidence.
