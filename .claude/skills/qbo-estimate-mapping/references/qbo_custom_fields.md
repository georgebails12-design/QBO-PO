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
