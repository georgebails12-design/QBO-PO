---
name: qbo-estimate-mapping
description: Pull QuickBooks Online sales estimates (with FULL custom field detail — Dealer, RSM, Deposit Due, Q#/Project, Customer PO, etc.), and/or compare a CenterPoint quoting-system XML export against its resulting QBO estimate to trace how the data was mapped and where dealer markup was applied. Use this whenever the user asks to pull, review, or table QBO estimate data with custom fields; asks about Q#/PO numbers, RSM, Dealer, or Residential/Commercial fields on an estimate; uploads or references a CenterPoint "Quote_####_export.xml" file; asks to map, reconcile, or compare estimate data to a source quote file; or wants a field-mapping spreadsheet/JSON for QBO estimate data to feed into automation (n8n, scripts). Push to use this proactively any time QBO custom fields or CenterPoint XML exports come up, even if the user doesn't name this skill.
---

# QBO Estimate + CenterPoint Mapping

This skill captures a workflow discovered by trial and error in this repo (QBO-PO, for Panda
Windows & Doors): pulling a QuickBooks Online sales estimate with *all* of its custom field
data, and — when a CenterPoint quoting-system XML export is available — tracing exactly how
that source data became the QBO estimate.

## 1. Pulling a QBO estimate with full custom field detail

The `qbo_sales_get_estimates` tool behaves differently depending on how you look an estimate up:

- **Looking up by `doc_numbers` (e.g. `"11180"`) returns a TRIMMED `custom_fields` array** —
  often just one or two fields (e.g. only "Deposit Due"), silently dropping the rest.
- **Looking up by `estimate_ids` (the internal QBO GUID, e.g.
  `djQuMTo5MzQxNDU0NTQ3NTI2NDQ2OjgwMjcxZWRkOGE:484773`) returns the FULL `custom_fields`
  array**, including every definition ID, picklist option list, and current value.

So the reliable two-step pattern is:

1. Call `qbo_sales_get_estimates` with `doc_numbers: ["11180"]` to resolve the doc number to its
   internal `id`.
2. Call it again with `estimate_ids: [<that id>]` to get the complete custom field set.

Never report an estimate's custom fields as "empty" or "not set" based on a `doc_numbers` lookup
alone — always re-check by `estimate_ids` first, since the doc_numbers response silently
truncates the array rather than erroring.

See `references/qbo_custom_fields.md` for the full custom field reference (title, definition ID,
type, and known picklist values) built from this discovery process — reuse it instead of
re-deriving field meanings from scratch each time.

**Known limitation**: `qbo_sales_create_estimate` and `qbo_sales_update_estimate` have no
`custom_fields` parameter. These fields cannot be written through those tools — they must be set
manually in the QBO UI, or through a direct QuickBooks API call (e.g. from an n8n workflow) that
PATCHes the `CustomField` array on the SalesTransaction. Say this plainly if a user asks you to
set a Dealer/RSM/etc. value via one of those tools — don't attempt a workaround parameter.

**Customer/Project convention**: `contact.display_name` on an estimate is always
`"Customer:Project"` — the parent QBO customer, a colon, then the project (a sub-customer/job
under it). When creating a new estimate for an existing project, resolve the *project's* QBO
customer_id via `search_customer`, not the parent company's.

## 2. Comparing a CenterPoint XML export to its QBO estimate

Panda Windows & Doors quotes originate in a system called CenterPoint
(`ApplicationName` = "PandaWindowsTest CenterPoint" in the export). When a user attaches a
`Quote_####_export.xml` file and wants it compared/mapped to a QBO estimate, this is what to
know before diving in:

- **These files are large (multi-MB) and single-line** — don't try to `Read` them directly, use
  Python's `xml.etree.ElementTree` and query specific fields/paths.
- The root `<quote>` element has ~250 direct children, mostly scalars in a `<tag Value="..." />`
  pattern (a few, like `userquotenumber`, are plain element text instead).
- Several children (`quoteheader`, `Billing`, `Shipping`, `clientinfo`, `projectowner`, `notes`,
  `projectinfo`) are **escaped nested XML strings** — parse `element.text` with `ET.fromstring`
  again to get at their contents.
- The actual priced content lives under `lineitemmasters/lineitemmaster/...`, and
  `lineitemmaster/lineitems/lineitem/...` for sub-components. **Skip
  `AdditionalDrawings`, `unitconfiguration`, `serializeddrawingprimesnative`, `extradata`,
  `limitations`, and similar** — these are huge base64-encoded drawing blobs that account for
  nearly all the file's size and have nothing to do with pricing or custom fields.
- The real per-quote business fields (RSM, dealer markup schedule, crating fee, freight,
  residential/commercial type, deposit schedule) are inside `quoteheader` →
  `QuoteHeaderData/QuoteHeader` as generically-named `Configurable##` fields. **There is no
  built-in legend for what each Configurable## means** — it has to be inferred by comparing
  values against the known QBO custom fields on the matching estimate. `references/centerpoint_configurable_fields.md`
  records what's been decoded so far; extend it as more Configurable## meanings are confirmed
  rather than re-guessing from zero each time.

**Matching a CenterPoint quote to its QBO estimate**: the CenterPoint `quotename`/`projectname`
is formatted `"QQ#<number> <Project Name>"`. That `<number>` is the value that lands in QBO's
"Q Number/PO #" / "Customer PO" custom field — match on that, *not* on `userquotenumber` (that's
CenterPoint's own internal quote ID and has no QBO counterpart).

**The pricing relationship is not 1:1** — CenterPoint exports Panda's price *to the dealer*
(its `customerextendedprice` field, with `dealermarkuppct` = 0 in the raw export). The QBO
estimate line amount includes the dealer's own markup on top, applied outside this file. That
markup percentage **varies by dealer** — don't assume a constant rate; compute it per estimate as
`(qbo_line_amount - centerpoint_price) / centerpoint_price` and report it, rather than predicting
what a new estimate's price "should" be.

One CenterPoint `lineitemmaster` (a fully configured unit, e.g. a door with integrated sidelites)
can expand into **multiple QBO lines**: one priced line for the main configuration, plus $0.00
lines for included sub-components that QBO itemizes separately. Don't be surprised by $0 lines in
a QBO estimate that don't have an obvious priced counterpart in CenterPoint — check whether
they're sub-components of a single CenterPoint master first.

Fee-type charges (crating, in the confirmed examples) pass through from CenterPoint to QBO
**unmarked-up** — only the manufactured unit price gets the dealer markup. Verify this
assumption still holds before treating a new fee field as automatically pass-through.

## 3. Producing the deliverables

Depending on what the user asks for, build one or more of:

- **A JSON mapping/reconciliation file** (see `webapp/estimate_mapping/centerpoint_to_qbo_mapping.json`
  in this repo for the established format: `header_field_mapping`, `line_item_field_mapping`,
  `price_reconciliation`, `open_questions`). Extend this file rather than creating a parallel one
  when mapping additional quotes — it should accumulate confirmed mappings over time.
- **A field-to-JSON-path reference table** (xlsx + csv) for feeding into automation — see
  `webapp/estimate_mapping/estimates_field_map.xlsx` / `field_map.csv` / `line_items.csv` for the
  established column layout (Field Label, Category, JSON Path, Custom Field Def. ID, Type, one
  column per estimate). Use the `anthropic-skills:xlsx` skill's conventions when building these
  (Arial font, currency number formats). **Note**: LibreOffice recalculation
  (`scripts/recalc.py`) has been observed to hang/fail in this environment's sandbox — if that
  happens again, write plain computed values instead of live formulas rather than shipping a file
  with unverified formulas, and say so to the user.
- **A visual comparison table** (Artifact) when the user wants to "review" or "see" estimates
  side by side, rather than consume the data programmatically — use the Artifact tool's plain-page
  path (utilitarian treatment: real typographic hierarchy, considered spacing, no flashy hero).

When a user just wants a quick read of custom field values, a chat table is enough — save the
file-producing steps above for when they ask for something to reuse, review formally, or feed
into another tool.

## Reference files

- `references/qbo_custom_fields.md` — every QBO custom field discovered on Panda's estimates
  (title, definition ID, type, picklist values where known).
- `references/centerpoint_configurable_fields.md` — decoded meanings of CenterPoint's
  `Configurable##` fields, with confidence notes for ones that are still guesses.
