# QuickBooks Online: invoice custom fields and RSM mapping

Reference for Panda Windows & Doors' QuickBooks Online company (realm `9341454547526446`).
Use it anywhere invoices, estimates or payments are read from the QBO API: the PO app's Sales Dashboard, n8n workflows, reports.

_Last updated: October 2026._

## Reading custom fields from the API

RSM, 2nd RSM, Dealer and the other fields below are QBO's newer **dropdown custom fields**. Two things to know:

1. **They only come back if you ask for them.** Add `include=enhancedAllCustomFields` and `minorversion=75` (70 or higher) to the request; without them most of these fields are missing from the response.
2. **Dropdowns return the option's number, not its label.** `StringValue` is `"11"`, not `"Sean"`. Use the tables below to turn numbers into names.

```http
GET https://quickbooks.api.intuit.com/v3/company/9341454547526446/query
    ?query=select * from Invoice where TxnDate >= '2026-01-01'
    &minorversion=75
    &include=enhancedAllCustomFields
```

A field on the invoice looks like this:

```json
{ "DefinitionId": "1000000027", "Name": "RSM", "Type": "StringType", "StringValue": "11" }
```

Match on `Name` (trim it: `"Customer PO "` has a trailing space) or on `DefinitionId`.

## Field definitions

| Field | DefinitionId | Kind | Notes |
|---|---|---|---|
| Q Number/PO # | `1000000016` | Text | Job / quote number; matches monday Q# and SO# |
| Sales Rep | `1000000017` | Text | Older field, rarely used (initials) |
| Residential or Commercial | `1000000019` | Dropdown | See list below |
| Dealer | `1000000020` | Dropdown | See list below |
| Sales Team | `1000000021` | Dropdown | Labels not documented |
| Outside Sales Rep | `1000000022` | Dropdown | Labels not documented |
| RSM | `1000000027` | Dropdown | See list below; on ~99% of invoices |
| 2nd RSM | `1000000028` | Dropdown | Separate list with different numbers from RSM |
| Q#/Project | `1000000029` | Text | On invoices: rare. On purchase orders the Q#/Project field is DefinitionId `2` |
| JDM Folder | `1000000030` | Text |  |
| Customer PO | `1000000033` | Text | Name has a trailing space in QBO |
| Sales Tax Exempt | `1000000034` | Text | Yes / No |
| SA | `1000001067` | Dropdown | Labels not documented |

## RSM

`DefinitionId` `1000000027`. The **Name** column is the label used in QuickBooks reports and the Sales Dashboard. **Full name** is the matching monday.com person, where known.

| # | Name | Full name (monday.com) | Source |
|---|---|---|---|
| 1 | Avi Shoshan | Avi Shoshan | Custom_Field_Mapping.xlsx |
| 2 | Efrain | Efrain Zarate | Custom_Field_Mapping.xlsx |
| 3 | Trever | Trevor Benthagen | Custom_Field_Mapping.xlsx |
| 4 | Emanuel Teral(Alex) | Alex | Custom_Field_Mapping.xlsx |
| 5 | Jarron | Jaron Krause | Confirmed by George, Oct 2026 |
| 6 | Derrick | Derrick McCall | Custom_Field_Mapping.xlsx |
| 7 | Troy | Troy Kite | n8n AR workflow |
| 8 | Cassandra | Cassandra Gromoll | Confirmed by George, Oct 2026 |
| 9 | Luke | Luke Valles | Confirmed by George, Oct 2026 |
| 10 | Private Label | Alex (Private Label) | Custom_Field_Mapping.xlsx |
| 11 | Sean | Sean Torre | Custom_Field_Mapping.xlsx |
| 12 | Service |  | Custom_Field_Mapping.xlsx |
| 13 | Stefan | Stefan Monetta | Custom_Field_Mapping.xlsx |
| 14 | Tad | Tad Shurtleff | Confirmed by George, Oct 2026 |
| 15 | Spencer | Spencer Anderson | n8n AR workflow |
| 16 | Mary | Mary Wursten | Confirmed by George, Oct 2026 |
| 17 | Kevin |  | Confirmed by George, Oct 2026 |
| 18 | Tyler | Tyler Clark | Custom_Field_Mapping.xlsx |
| 19 | Jesse |  | Confirmed by George, Oct 2026 |
| 20 | Joe Smith | Joe Smith | Confirmed by George, Oct 2026 |
| 22 | Jameson | Jameson Dahn | Confirmed by George, Oct 2026 |
| 23 | David Rodriquez | David Rodriguez | Custom_Field_Mapping.xlsx |
| 24 | William |  | Custom_Field_Mapping.xlsx |

Notes:

- **#16 and #18 are different people.** 16 is Mary; 18 is Tyler. Older lists had 16 = Tyler, which is wrong.
- #21 has never appeared on an invoice since Jan 2025 and has no known label.
- A blank RSM shows as "No RSM on invoice" on the dashboard (about 1% of invoices).
- Spellings follow QuickBooks/the mapping sheet: "Trever", "Jarron" and "David Rodriquez". monday.com spells them Trevor, Jaron and Rodriguez.

## 2nd RSM

`DefinitionId` `1000000028`. **Different numbering from RSM**: 2nd RSM #1 is Efrain, but RSM #1 is Avi.

| # | Name |
|---|---|
| 1 | Efrain |
| 2 | Trever |
| 6 | Derrick |
| 10 | Sean |
| 11 | Stefan |
| 16 | NO |
| 17 | Efrain/Trever |
| 19 | Tyler |
| 20 | Greg Brawner |

Numbers 3, 4, 7, 8, 12, 13, 14 and 15 also appear on invoices but have no confirmed label yet. #8 is used on about 70 invoices; monday.com mostly matches it to Mary Wursten, but that is unconfirmed.

## Residential or Commercial

`DefinitionId` `1000000019`.

| # | Name |
|---|---|
| 1 | Residential -Single Family |
| 2 | Multi-Family |
| 3 | Hotel / Resort |
| 4 | Country Clubs / Private Clubs |
| 5 | Museums / Art Galleries |
| 6 | Bar / Restaurants |
| 7 | Educational Facility |
| 8 | Sports / Entertainment Venues |
| 9 | Office Building |
| 10 | Religious Facility |
| 11 | Retail |
| 12 | Showroom |
| 13 | Goverment |

## Dealer

`DefinitionId` `1000000020`. Numbers 1–24 come from the mapping sheet. The sheet lists the remaining dealers without numbers; they are listed here in sheet order, but their option numbers are **not confirmed**.

| # | Dealer |
|---|---|
| 1 | NO |
| 2 | Alanor Ventanas (inactive) |
| 3 | Arcadia Sash and Door |
| 4 | Builders Direct |
| 5 | Home Depot |
| 6 | J Shuman Door Installations |
| 7 | Lowes |
| 8 | Marsh Building Products (inactive) |
| 9 | Precision Glass |
| 10 | Reeves Ace Hardware |
| 11 | Sierra Pacific |
| 12 | Tier One Custom Windows |
| 13 | Wenatchee Valley Glass |
| 14 | West Coast Window (inactive) |
| 15 | The Window Store |
| 16 | Wood Masters Construction Inc. |
| 17 | JS Glass & Mirror, Inc |
| 18 | Ken Caryl Glass Inc |
| 19 | Polk Architectural |
| 20 | E & Z Glass & Window |
| 21 | Blue Fenestration |
| 22 | J & A Glass & Mirror, Inc |
| 23 | Hilton Head Island Windows & Doors |
| 24 | Fast Glass |
| ? | Dixie Line Lumber |
| ? | Specialty North America (inactive) |
| ? | BMG Door & Glass |
| ? | Hardman Glazing |
| ? | 1st Choice Window & Door |
| ? | 4x4 Construction |
| ? | Action Windows and Doors |
| ? | Architectural Window & Door |
| ? | AWD Systems |
| ? | Benchmark Window & Door |
| ? | BlackRock Southwest Development |
| ? | Bluestem Fenestration |
| ? | Boulder Ridge |
| ? | Clerestory |
| ? | Desert Lumber and Building Materials |
| ? | Designer Windows and Doors Ltd |
| ? | Donatello Bonasera Development |
| ? | Don's Mobile Glass |
| ? | Doors, Etc. |
| ? | E&Z Glass & Window |
| ? | Eagle Windows & Doors |
| ? | Ecotech Windows, Doors, Glass |
| ? | Epsilon |
| ? | EuroVision Glass |
| ? | Evergreen Premier |
| ? | Exclusive Iron Doors |
| ? | Folding Door Store |
| ? | Four Corners Building Supply |
| ? | Frontier Glass |
| ? | Hammer Building Supply |
| ? | Harbour Classic custom homes |
| ? | HBS, Inc. |
| ? | Houck Construction |
| ? | JDF Industries |
| ? | JS Glass |
| ? | Ken Carl Glass |
| ? | McCoy's Building Supply |
| ? | Michigan Window & Door |
| ? | Northland Interiors |
| ? | Peak Glass |
| ? | Polk Architecture |
| ? | Quality Window & Door |
| ? | R & S Companies |
| ? | Riverwoods Mill |
| ? | Rocky Mountain Windows & Doors |
| ? | Sergi's Images |
| ? | Skyline Window |
| ? | Sol Installs |
| ? | Sound Glass |
| ? | Stratos Development |
| ? | Studio 3 Architectural |
| ? | Super Enterprises/ Lavitt Group |
| ? | The Coastal Window & Door Center |
| ? | Tridel Co. |
| ? | Turkel Systems |
| ? | Window Classics |
| ? | Window Craft Inc |
| ? | Z Double B |
| ? | Desert Windows Systems |
| ? | Best Window Company |
| ? | Westline WIndows |
| ? | Epic Design Group Inc |
| ? | Western Pacific |
| ? | Marvin Design Gallery |
| ? | AS Designs |
| ? | Advanced Window |
| ? | Builders First Source |
| ? | OC Patio Doors |
| ? | Socal Windows & Glazing |
| ? | JDP Associates |
| ? | Scanlon Construction |
| ? | Integrated Door and Window Systems, Inc. |

## Sales and cash definitions (Sales Dashboard)

How the PO app's Sales Dashboard (`webapp/sales_dashboard.py`) counts sales and cash. Use the same rules elsewhere so numbers agree.

**Sales:** invoice lines that post to an **Income** account, by invoice date, minus credit memos counted the same way.

- Deposit invoices post to **2115 Customer Deposits**. The final invoice backs the deposit out with a negative "Z Fees:Deposit" line to the same account. Adding up invoice totals would therefore count every deposit twice.
- Sales tax lines post to **2201 Sales Tax Payable** (or the Avalara payable) and are excluded.
- Shipping (4203), service revenue (4204), returns (4800) and discounts are Income and are included.

**Cash collected:** customer payments (`Payment.TotalAmt`) by payment date.

- About 20% of Payment records are $0. These only apply a journal-entry or credit-memo credit to an invoice and are not cash.
- Each payment is credited to the RSM on the invoice(s) it was applied to, split by the amount applied to each. Cash not applied to any invoice is "Not applied to an invoice".

**RSM:** taken from the invoice's RSM field, using the table above.

## Machine-readable RSM map

```json
{
  "1": "Avi Shoshan",
  "2": "Efrain",
  "3": "Trever",
  "4": "Emanuel Teral(Alex)",
  "5": "Jarron",
  "6": "Derrick",
  "7": "Troy",
  "8": "Cassandra",
  "9": "Luke",
  "10": "Private Label",
  "11": "Sean",
  "12": "Service",
  "13": "Stefan",
  "14": "Tad",
  "15": "Spencer",
  "16": "Mary",
  "17": "Kevin",
  "18": "Tyler",
  "19": "Jesse",
  "20": "Joe Smith",
  "22": "Jameson",
  "23": "David Rodriquez",
  "24": "William"
}
```
