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
| Deposit Due | 1000000023 | currency (free-text, e.g. `"$15,928.34"`) | Observed to equal exactly 50% of the estimate total on every example so far — likely driven by a 50/50 deposit schedule (see CenterPoint `Configurable27`). |
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

## Worked example: the raw API call to set sub-customer + custom fields

This is the request an n8n HTTP Request node (or Postman, or a script) would need, since no MCP
tool here can do it. **Unverified — derived from Intuit's general Custom Fields API pattern, not
executed against a live company.** Test on a single field first and confirm the response shape
before batch-applying.

1. `GET /v3/company/<realmId>/customer/<id>` first to read the current `SyncToken` — every QBO
   update requires the record's current SyncToken or it's rejected.
2. Sparse-update with the parent link and custom fields together:

```json
POST /v3/company/<realmId>/customer?minorversion=65
{
  "Id": "<the sub-customer's QBO numeric Id>",
  "SyncToken": "<from step 1>",
  "sparse": true,
  "Job": true,
  "ParentRef": { "value": "<the parent customer's QBO numeric Id>" },
  "CustomField": [
    { "DefinitionId": "1000000019", "Name": "Residential or Commercial", "Type": "StringType", "StringValue": "Residential -Single Family" },
    { "DefinitionId": "1000000027", "Name": "RSM", "Type": "StringType", "StringValue": "Trever" }
  ]
}
```

`Job: true` + `ParentRef` together are what the QBO UI's "Sub-customer/job of" checkbox actually
sets. Note the QBO numeric Id here is the MCP tools' `local_id` field, not the long
`djQuMTo...` wrapped ID those tools return as `id` — the wrapped ID is this integration's own
encoding, not what the raw REST API expects.
