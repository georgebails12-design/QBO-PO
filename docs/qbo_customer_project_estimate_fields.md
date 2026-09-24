# QBO master field list: Customer → Project → Estimate

> **Superseded:** the current list is `qbo_customer_project_estimate_fields.xlsx`. It was narrowed to what estimates 11183, 11172, 11179, 11155 and 11135 actually use, and includes a side-by-side comparison tab.

Built from the n8n workflows on 2026-09-24:

- **QBO - Master Field List Probe (read-only)** (`TcfDrNFUzcyf7vLa`, execution 103): company Preferences, the 10 newest Estimates and the 10 newest Customers.
- **TEST-001 Custom Field Write Test** (`1tF9QG7psykePj1t`, executions 66–76)
- **Test Project Sub-Customer Write Test** (`86wUImQUMLfMBTPy`, execution 68)
- **QBO GraphQL Access Test** (`qLRudb67GS2ldSde`, execution 102)
- **Automate Quickbook Customer & Estimation Creation** (`QXxPOCPnF5oAQPD1`), the starter template

"Seen" is how many of the 10 recent records had the field filled in.

Status key: **Req** = QBO rejects the create without it. **Rec** = your team fills it in on every record. **Opt** = optional.

---

## 1. Customer (the parent company or person)

| # | Data point | QBO API field | Status | Seen | Notes |
|---|---|---|---|---|---|
| 1 | Display name | `DisplayName` | **Req** | 10/10 | Must be unique across Customers, Vendors and Employees. The search-before-create step matches on this field. |
| 2 | Company name | `CompanyName` | Opt | – | The template workflow maps it. |
| 3 | First / last name | `GivenName`, `FamilyName` | Opt | – | Used for homeowners (e.g. "Robert Capp"). |
| 4 | Primary email | `PrimaryEmailAddr.Address` | **Rec** | 10/10 | Some records hold 2 comma-separated addresses (Sierra Pacific). |
| 5 | Phone | `PrimaryPhone.FreeFormNumber` | Opt | 0/10 | The template maps it, but none of the recent records had it. |
| 6 | Mobile | `Mobile.FreeFormNumber` | Opt | – | |
| 7 | Billing address | `BillAddr.Line1`, `City`, `CountrySubDivisionCode`, `PostalCode` | **Rec** | 4/4 parents | Every parent customer had one. |
| 8 | Shipping address | `ShipAddr.*` | **Rec** | 4/4 parents | Usually the same as billing. |
| 9 | Customer type | `CustomerTypeRef.value` | Opt | 4/10 | `573164` was used for dealer accounts (Woodgrain, Sierra Pacific, Tier One). |
| 10 | Taxable | `Taxable` | Rec | 10/10 | Parents were `true`, projects `false`. |
| 11 | Default tax code | `DefaultTaxCodeRef` | Rec | 10/10 | Always `999`. |
| 12 | Terms | `SalesTermRef` | Opt | – | The company default is terms id `41`. |
| 13 | Preferred delivery | `PreferredDeliveryMethod` | Opt | 10/10 | Always `Print`. |
| 14 | Notes | `Notes` | Opt | – | |
| 15 | Resale number | `ResaleNum` | Opt | – | For dealers and wholesale buyers. |
| – | Custom fields | – | – | – | This company has **no customer-level custom fields**. |

## 2. Project (job under a customer)

Projects are turned on (`ProjectsEnabled = true`). In the API a project is a **Customer record** with these extra fields:

| # | Data point | QBO API field | Status | Seen | Notes |
|---|---|---|---|---|---|
| 1 | Project name | `DisplayName` | **Req** | 6/6 | This is the job address or PO number, e.g. "736 El Medio" or "4500843235" (Woodgrain PO). |
| 2 | Parent customer | `ParentRef.value` | **Req** | 6/6 | The Customer Id from section 1. |
| 3 | Is sub-customer | `Job = true` | **Req** | 6/6 | |
| 4 | Bill with parent | `BillWithParent = true` | Rec | 6/6 | |
| 5 | Email | `PrimaryEmailAddr` | Rec | 6/6 | Copied from the parent. |
| 6 | Taxable | `Taxable = false` | Rec | 6/6 | |
| 7 | Customer type | `CustomerTypeRef` | Opt | 4/6 | Inherited on dealer jobs. |
| 8 | Job site address | `ShipAddr.*` | Opt | 0/6 | Projects had no address. The address is on the estimate instead. Add it here if you want it stored on the project. |
| 9 | Start / end date, status | – | – | – | Only set in the Projects screen. The REST API can't write them. |

> ⚠️ **API limitation:** the REST API (v3) can make a **sub-customer** (`Job=true` + `ParentRef`). Execution 68 did this and it worked. That record still has **`IsProject = false`**. Only records created in the QBO Projects screen have `IsProject = true` and a `ProjectRef` id (e.g. `814486038`). Intuit's Projects API is GraphQL only, and our current credential gets **403 Forbidden** there (execution 102). An automated flow has two options: (a) use sub-customers, or (b) create the project in QBO first, then have the flow find it.

## 3. Estimate

### Header

| # | Data point | QBO API field | Status | Seen | Notes |
|---|---|---|---|---|---|
| 1 | Customer / project | `CustomerRef.value` | **Req** | 10/10 | Point this at the **project** when there is one. |
| 2 | Project link | `ProjectRef.value` | Rec | 5/10 | Only a real Project (`IsProject=true`) has one. |
| 3 | Estimate # | `DocNumber` | **Rec** | 10/10 | Custom numbers are on. Current sequence is ~11198. |
| 4 | Estimate date | `TxnDate` | Rec | 10/10 | |
| 5 | Expiration date | `ExpirationDate` | Opt | 0/10 | |
| 6 | Status | `TxnStatus` | Auto | 10/10 | Pending, Accepted, etc. |
| 7 | Accepted date / by | `AcceptedDate`, `AcceptedBy` | Opt | 3/10 | |
| 8 | Bill-to address | `BillAddr.Line1-3` | **Rec** | 10/10 | Written as free-form lines, e.g. "Scanlon Construction / 10650 Overman Avenue / Chatsworth, CA 91311". |
| 9 | Ship-to address | `ShipAddr.Line1-3` | **Rec** | 10/10 | The job site, or "Local Pickup / 3415 Bellington Rd…". |
| 10 | Ship-from address | `ShipFromAddr` | Opt | 1/10 | |
| 11 | Bill email (To) | `BillEmail.Address` | **Rec** | 10/10 | |
| 12 | Cc | `BillEmailCc.Address` | Rec | 9/10 | The sales rep, e.g. tyler@panda-windows.com. |
| 13 | Bcc | `BillEmailBcc.Address` | Rec | 9/10 | Always Accounting@panda-windows.com. |
| 14 | Customer message | `CustomerMemo` | Rec | 10/10 | The payment-terms text the company fills in by default. |
| 15 | Internal memo | `PrivateNote` | Opt | 1/10 | |
| 16 | Tax code | `TxnTaxDetail.TxnTaxCodeRef` | Rec | 10/10 | `999`, rate `1174` at 0%. |
| 17 | Terms | `SalesTermRef` | Opt | 0/10 | |
| 18 | Class / Location | `ClassRef`, `DepartmentRef` | – | 0/10 | Not used. |
| 19 | Shipping charge | `ShipAmt` / shipping line | Opt | – | Shipping is on (acct `1303`). |
| 20 | Deposit | `Deposit` | Opt | – | Deposits are on. Your team uses the "Deposit Due" custom field (below). |

### Custom fields (header)

**A. Legacy sales-form fields.** The v3 API reads and writes these without problems.

| DefinitionId | Name | Seen | Notes |
|---|---|---|---|
| `1` | **Q Number/PO #** | 1/10 | The company's Q number or the customer's PO number. |
| `2` | **Sales Rep** | 0/10 | Set up in QBO, but never filled in. |
| `3` | **Deposit Due** | 10/10 (value on 3) | Stored as text, e.g. "$166,515.42". |

**B. Newer custom fields**, from the `TEST-001 Custom Field Write Test` workflow.

| DefinitionId | Name | Example value |
|---|---|---|
| `1000000019` | Residential or Commercial | "Residential -Single Family" |
| `1000000020` | Dealer | "NO" |
| `1000000022` | Outside Sales Rep | "NO" |
| `1000000027` | RSM | "Trever" |

> ⚠️ In executions 66–76 the v3 API returned **success, but none of these 4 values were saved**. The record that came back only had fields 1 and 3. You can set them in the QBO screen. Writing them from a workflow needs Intuit's GraphQL custom-fields API, and our credential gets 403 there today. Other newer fields may exist that we can't see. Please check **Settings → Custom fields** in QBO.

### Line items

| # | Data point | QBO API field | Status | Notes |
|---|---|---|---|---|
| 1 | Product/Service | `SalesItemLineDetail.ItemRef.value` | **Req** | e.g. `1813` "PandaSelect Multi-Slides:TS.30", `1953` "Fixed Windows:TS.77F". |
| 2 | Description | `Description` | **Rec** | e.g. "All Aluminum Thermally Broken Panda Select Multi-Slide". |
| 3 | Qty | `SalesItemLineDetail.Qty` | **Rec** | |
| 4 | Rate | `SalesItemLineDetail.UnitPrice` | **Rec** | |
| 5 | Amount | `Amount` | **Req** | Must equal Qty × Rate. |
| 6 | Tax | `SalesItemLineDetail.TaxCodeRef` | Rec | `TAX` |
| 7 | Service date | `SalesItemLineDetail.ServiceDate` | Opt | Service dates are turned on. |
| 8 | Line dimensions | `CustomExtensions[DIMENSION].AssociatedValues` | Rec | 3 dimensions were set on **every** line. See below. |
| 9 | Subtotal line | `SubTotalLineDetail` | Opt | |
| 10 | Discount line | `DiscountLineDetail` (acct `1308`) | Opt | Flat or %. Seen 1/10. |

**Line dimensions.** The API only returns these as ID numbers. Names can't be looked up without GraphQL.

| Dimension key | Distinct values seen | What it might be (please confirm) |
|---|---|---|
| `1000000039` | 22 | Probably product line or series |
| `1000000051` | 20 | Probably finish or color |
| `1000000172` | 5 | Probably a small category list, e.g. product type or channel |

---

## Questions to answer before building

1. Are there more **customer** fields you want? The ones not used today are phone, mobile, terms, customer type, resale #, and notes.
2. Should the job site address be saved on the **project** record, or only on the estimate ship-to?
3. **Sales Rep (legacy #2)** is set up but never used. Keep it, or stay with **RSM / Outside Sales Rep**?
4. Which **newer custom fields** are required on every estimate? (Residential or Commercial, Dealer, Outside Sales Rep, RSM, plus any others in QBO Settings.)
5. What are the names of the 3 line dimensions (`…039`, `…051`, `…172`), and should the flow fill them in?
6. Should the flow fill in **Expiration date**, **Terms**, or a **Deposit** amount?
