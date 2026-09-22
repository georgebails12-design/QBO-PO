# QBO Estimate Custom Fields (Panda Windows & Doors)

Discovered by pulling estimates 11180, 11172, and 11152 via `qbo_sales_get_estimates` with
`estimate_ids` (the doc_numbers lookup path truncates this list — see SKILL.md). Each field's
`custom_fields[].definition.id` ends in the numeric ID below; `definition.schema.title` is the
human label shown in the QBO UI.

| Title | Definition ID | Type | Notes |
|---|---|---|---|
| Residential or Commercial | 1000000019 | picklist | 13 options incl. Residential -Single Family, Multi-Family, Hotel/Resort, Showroom, Retail, Office Building, etc. |
| Dealer | 1000000020 | picklist | ~90+ options (some deleted/legacy). Use "NO" when there is no dealer. |
| Outside Sales Rep | 1000000022 | picklist | Use "NO" when none. |
| Deposit Due | 1000000023 | currency (free-text, e.g. `"$15,928.34"`) | Equals 50% of **(Total − any "Total sales tax" line item)**, not 50% of the raw total — confirmed on estimate 11179, where a sales tax line ($8,064.16) is present: (106,377.76 − 8,064.16) × 50% = 49,156.80, exact match. On estimates with no tax line (11172, 11152) this collapses to 50% of total, which is what made the simpler rule look right at first. Likely driven by a 50/50 deposit schedule (see CenterPoint `Configurable27`) applied to the pre-tax amount. **This is a plain text custom field, entered by hand or by whatever built the estimate — it is NOT the same as QBO's native deposit-request feature (below) and setting one does not set the other.** |

**QBO's native deposit request** (`update_estimate`'s `deposit: {percent}`/`{amount}` parameter,
surfaced in the estimate response as `deposit.requested_amount`/`deposit.paid_amount`) is a
**separate, unrelated mechanism** from the "Deposit Due" custom field above — confirmed by
setting `deposit: {percent: 50}` on a test estimate and re-fetching it: `deposit.requested_amount`
became `"100.00"` while the "Deposit Due" custom field stayed `null`. Whoever built 11180/11172/
11152/11179 populated "Deposit Due" by hand (or via CenterPoint/n8n automation) as a distinct step
— it was never derived from the native deposit request feature, and setting the native one is not
a substitute for filling the custom field.
| RSM | 1000000027 | picklist | First-name-only values (Trever, Efrain, Sean, Avi Shoshan, etc.) |
| 2nd RSM | 1000000028 | picklist | Optional; often blank. |
| Q#/Project | 1000000029 | text | Free-text project/quote number. Not always populated — sometimes only "Customer PO" carries the number. |
| Customer PO | 1000000033 | text (title has a trailing space: `"Customer PO "`) | Customer's own PO/quote reference. This is where the CenterPoint "QQ#" number lands. |
| JDM Folder | 1000000030 | text | Usually blank. |
| Sales Tax Exempt | 1000000034 | text/boolean | Usually blank. |
| Lead Source | 1000001086 | text | Usually blank. |

## Gotchas

- **`doc_numbers` lookup truncates `custom_fields`.** A lookup by doc number (e.g. `"11180"`)
  might return only 1-2 custom fields (commonly just "Deposit Due"). Always re-fetch by
  `estimate_ids` to get the complete list before concluding a field is unset.
- **Picklist values sometimes come back as coded IDs** (e.g. `"1000000019_1"`) instead of the
  display string, depending on which lookup path was used. Cross-reference against the
  `allowedValues` list in the field's `definition.schema` (only present on the full,
  `estimate_ids`-based response) to decode them.
- **`contact.display_name`** is `"Customer:Project"` — not a custom field, but essential for
  matching estimates to CenterPoint quotes and for creating new estimates against the right
  sub-customer.
- **No custom_fields parameter on write.** `qbo_sales_create_estimate` /
  `qbo_sales_update_estimate` cannot set any of the above. They must be set manually in QBO, or
  via a direct API call outside these MCP tools.
- **A deleted custom field definition can still hold a value and still appear in the array.**
  Estimate 11179 carries a value (`"91229"`) under a field whose `definition.deleted` is `true`
  and whose title is also "Q Number/PO #" (definition id `1000000016` — a different, older
  definition ID than the live one at `1000000029`). Its value did NOT match the live "Customer
  PO" field (`714093`) on the same estimate — on every other estimate seen so far those two
  numbers were identical. Don't assume they always agree; check both, and don't discard
  `deleted: true` entries as noise, since they may be the only place an original quote number
  survives after a field got reconfigured.
- **These fields also live on the Customer record**, not just the estimate — confirmed by the
  QBO "Edit Customer" screen showing the same field set (Residential or Commercial, Dealer,
  Outside Sales Rep, Deposit Due, RSM, 2nd RSM, Q#/Project, JDM Folder, Customer PO). This
  matches the `associatedEntityTypes` seen on each field's definition, which include
  `/network/Contact` with `subtype: CUSTOMER` alongside the transaction subtypes.
- **There is no `update_customer` tool in this MCP server at all** — only `create_customer`
  (which silently dedupes to an existing customer by name, per `found_existing` in its
  response) and `search_customer`. Neither `create_customer` nor any other tool exposes a
  parent-customer/`ParentRef` field or a custom-fields field. **Do not attempt to fake a
  sub-customer by putting a colon in `display_name`** (e.g. `"Parent:Child"`) — this was tried
  and QBO's API rejects it with `Invalid name`; a literal colon is not how sub-customer
  hierarchy works. There is currently no way to create a true sub-customer/project or set any
  customer-level custom field through these MCP tools — say so plainly rather than attempting a
  workaround, and point the user to the QBO UI (Edit Customer → set "Sub-customer/job of" +
  parent company) or a direct QuickBooks REST API call (`Customer.ParentRef` + `Job: true`,
  and a `CustomField` array patch) as the only real options.

## CONFIRMED (2026-09-22): there are TWO separate custom-field systems, and only one is writable via the classic REST API

This was tested live via an n8n workflow (HTTP Request nodes + the company's real
`quickBooksOAuth2Api` credential, workflow id `1tF9QG7psykePj1t`) against the test estimate
TEST-001, and verified afterward by reading it back through `qbo_sales_get_estimates`. Do not
re-derive this from scratch — the two systems behave completely differently:

**1. Legacy custom fields (definition ids `"1"`, `"2"`, `"3"`) — WRITABLE.** These are QBO's old
3-slot custom field feature. On this company: `"1"` = Q Number/PO #, `"2"` = Sales Rep (never seen
populated), `"3"` = Deposit Due. Confirmed by live test: a sparse POST to
`/v3/company/<realmId>/estimate` with
```json
{
  "Id": "<estimate id>",
  "SyncToken": "<current SyncToken>",
  "sparse": true,
  "CustomField": [
    { "DefinitionId": "3", "Name": "Deposit Due", "Type": "StringType", "StringValue": "$100.00 TEST" },
    { "DefinitionId": "1", "Name": "Q Number/PO #", "Type": "StringType", "StringValue": "TEST-Q1" }
  ]
}
```
actually set both values — confirmed by reading the estimate back afterward and seeing
`"value":"TEST-Q1"` / `"value":"$100.00 TEST"`. n8n's built-in QuickBooks node also exposes these
3 fields directly (`CustomFields.Field[].DefinitionId` + `StringValue`, with `DefinitionId`
populated via a `getCustomFields` load-options call) — no HTTP Request node needed if you're
using n8n and only need these 3 legacy fields.

**2. Modern custom fields (Residential or Commercial, Dealer, RSM, 2nd RSM, Q#/Project,
Customer PO, JDM Folder, Sales Tax Exempt, Lead Source — the `1000000019`-style ids) —
CONFIRMED NOT WRITABLE via the classic REST API. This is a hard product limitation, NOT a
scope/permission issue** — verified directly against the live Intuit Developer app on
2026-09-22, not just inferred from docs. The same live test tried writing
`DefinitionId: "1000000019"` ("Residential or Commercial") and `"1000000027"` ("RSM") through the
identical sparse-POST `CustomField` array used successfully for the legacy fields. The call
returned HTTP 200 and the SyncToken incremented, but the returned `Estimate.CustomField` array
still contained only the 3 legacy slots — the submitted modern fields were silently dropped, not
rejected with an error.

**A previous version of this note claimed the fix was adding an `app-foundations.custom-field-definitions`
OAuth scope and re-authorizing. That was WRONG — retract it if you find it anywhere else.**
Checked directly on the Permissions page for the actual Intuit app behind the
`quickBooksOAuth2Api` credential: only two scopes exist on that app, `com.intuit.quickbooks.accounting`
and `com.intuit.quickbooks.payment`, both already granted and **not editable toggles** — there is
no separate custom-fields scope to add, on this app or apparently on this class of app at all.
Also ruled out as causes: (a) the fields not being enabled for the Estimate form — every one of
them has `SALE_ESTIMATE` listed as an active, non-deleted entity type in its own definition
metadata, matching what's visibly rendered in the QBO UI; (b) wrong `DefinitionId` — these ids
were read directly off this same company's live estimates, not guessed.

**Actual conclusion**: the classic QuickBooks Accounting REST API's `CustomField` array has
always been hard-capped at exactly 3 slots (long predating "App Foundations"), independent of any
OAuth scope. Q Number/PO #, Sales Rep, and Deposit Due fill that fixed cap on this company. The
other custom fields (QuickBooks Online Advanced's newer field types, up to 10 more per company)
live entirely outside this REST mechanism — in Intuit's separate GraphQL-based Custom Fields
platform. Whether/how to get write access to that GraphQL platform (a distinct developer
enrollment, not a scope toggle on an existing app) is unconfirmed and unexplored — don't repeat
the earlier mistake of asserting a fix without testing it against the actual app first. The only
CONFIRMED way to set these 4+ fields today is manual entry in the QBO UI.

Sources:
- https://blogs.intuit.com/2025/12/01/custom-fields-api-extending-quickbooks-online-with-flexible-metadata/
- https://help.developer.intuit.com/s/article/Enhanced-Custom-Fields-for-QuickBooks-Online-Advanced
- https://help.developer.intuit.com/s/question/0D54R00007I7ImDSAV/custom-fields-in-quickbooks-online-api
- https://github.com/IntuitDeveloper/Sampleapp-Customfields-Nodejs
- https://www.erpag.com/news/erpag-api-intuit-quickbooks-online-oauth-2-0-authorization (scope reauthorization requirement)

**Sub-customer nesting** (`ParentRef` + `Job: true` on the Customer entity) — **CONFIRMED WORKING**,
tested live the same way (n8n workflow id `86wUImQUMLfMBTPy`): a sparse POST to
`/v3/company/<realmId>/customer` with
```json
{ "Id": "30810", "SyncToken": "<current>", "sparse": true, "Job": true, "ParentRef": { "value": "23787" } }
```
actually created the hierarchy — the response's `FullyQualifiedName` became `"Test:Test Project"`,
and re-reading the estimate through `qbo_sales_get_estimates` confirmed `contact.display_name`
also updated to `"Test:Test Project"`. So sub-customer/project creation IS automatable via the
classic REST API — it's specifically the modern custom fields that need the additional scope
described above.
