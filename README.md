# mcp-medicare-coverage

MCP server for Medicare Coverage

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `medicare_ncd_search` | Search current Medicare National Coverage Determinations (NCDs) by title, benefit category, or NCD number. NCDs describe national Medicare policy; they are not individualized coverage guarantees or medical advice. |
| `medicare_ncd_detail` | Retrieve one official Medicare National Coverage Determination by CMS document ID and optional version, including covered indications, limitations, effective dates, benefit category, and revision text. |
| `medicare_lcd_search` | Search current final Medicare Local Coverage Determinations (LCDs), optionally restricted to a state. LCDs are contractor- and jurisdiction-specific and can differ across locations. |
| `medicare_lcd_detail` | Retrieve one Medicare LCD by document ID and version. Detailed LCD text requires a CMS license-agreement bearer token because documents may contain licensed AMA/ADA/AHA material; pass _licenseToken obtained directly from CMS after accepting those terms. |
| `medicare_nca_search` | Search National Coverage Analyses (NCAs) and Coverage Analyses for Labs (CALs), including open and completed CMS evidence reviews. An open analysis is a policy process, not a coverage decision. |
| `medicare_nca_detail` | Retrieve one CMS National Coverage Analysis by document ID, including request, issue, benefit category, dates, decision memo, and public-comment status when supplied by CMS. |
| `medicare_recent_coverage_changes` | Recently published or updated national Medicare coverage documents from CMS, including NCDs, NCAs, CALs, MEDCAC meetings, and technology assessments. |
| `medicare_coverage_states` | List CMS Coverage API state identifiers used to scope local Medicare coverage searches. |
| `medicare_article_code_profile` | Retrieve one CMS Medicare Coverage Article with its CPT/HCPCS codes and contractor records. Licensed AMA/ADA/AHA content requires a caller-provided CMS license token. Code inclusion describes billing guidance, not guaranteed coverage or payment. |
| `medicare_local_coverage_variation` | Compare final LCD search matches across 1–15 states and Medicare Administrative Contractors. Different matching document counts or titles are policy signals, not proof of unequal beneficiary access or payment. |
| `medicare_coverage_timeline` | Retrieve official CMS version or revision history for an NCD, NCA, CAL, or LCD. LCD revision history requires a caller-provided CMS license token. Timeline entries describe policy publication history, not claims adjudication. |
| `medicare_hcpcs_utilization_trend` | Show annual Medicare Physician & Other Practitioners national utilization and payment metrics for one HCPCS code. Claims are fee-for-service aggregates with suppression and methodology limits; they do not measure total US use, coverage, demand, or company revenue. |
| `medicare_hcpcs_geography` | Compare state-level Medicare fee-for-service provider, beneficiary, service, and average-payment metrics for one HCPCS code and program year. State beneficiary counts across places of service must not be summed as unique people. |
| `medicare_provider_exposure` | Return a bounded sample of provider-level Medicare fee-for-service rows for one HCPCS code, optionally filtered by state, with the authoritative matching-row count. This is not a provider ranking and excludes suppressed/non-FFS activity. |
| `medicare_product_market_profile` | Combine national coverage-policy matches with annual Medicare fee-for-service utilization for a product/topic and caller-supplied HCPCS codes. CMS does not validate the product-to-code association; verify coding and policy details independently. |
| `medicare_part_d_drug_spending` | Search CMS Medicare Part D spending by brand or generic name and return 2020–2024 spending, claims, beneficiaries, dosage units, and unit-cost trends. Gross Part D spending is not manufacturer revenue, net price, profit, prescriptions, or total US sales. |
| `medicare_part_d_prescriber_exposure` | Return a bounded sample of Medicare Part D prescriber-by-drug rows for an exact brand name in one year, optionally filtered by state, with the authoritative matching-row count. This is not a prescriber ranking and suppressed/non-Part-D activity is absent. |
| `medicare_part_d_generic_competition` | Profile Medicare Part D brand rows sharing an exact generic name, including CMS’s reported manufacturer count and 2020–2024 spending/use trends. Manufacturer count is a CMS aggregate, not a list of companies, products on market, or market share. |
| `medicare_inpatient_drg_market` | Return a bounded sample of hospital-level Medicare fee-for-service inpatient rows for an exact MS-DRG and year, optionally filtered by state, with the authoritative matching-row count. Average payments are not hospital revenue or margin. |
| `medicare_outpatient_apc_market` | Return a bounded sample of hospital-level Medicare fee-for-service outpatient rows for an exact APC and year, optionally filtered by state, with the authoritative matching-row count. APC payments are claims aggregates, not hospital revenue or margin. |
| `medicare_hospital_service_trend` | Show annual national Medicare fee-for-service utilization and average-payment trends for one inpatient MS-DRG or outpatient APC using CMS geography/service aggregates. Trends exclude Medicare Advantage and do not measure total market demand, revenue, or profitability. |
| `medicare_dme_supplier_market` | Return a bounded API-order sample of Medicare fee-for-service DME supplier rows for an exact HCPCS code and year, optionally filtered by state, with the authoritative matching-row count. This is not a supplier ranking or total market size. |
| `medicare_dme_service_trend` | Show annual national Medicare fee-for-service DME supplier, beneficiary, claim, service, and average-payment metrics for one HCPCS code. It excludes Medicare Advantage and is not total market demand or company revenue. |
| `medicare_post_acute_provider_market` | Return a bounded API-order sample of Medicare post-acute provider rows for home health, hospice, or skilled nursing in one year and optional state, with the authoritative matching-row count. Payments are not provider revenue or margin. |
| `medicare_post_acute_trend` | Show annual national Medicare fee-for-service beneficiaries, stays, service days, and payments for home health, hospice, or skilled nursing. Program definitions and year basis differ by service and the figures are not provider revenue. |
| `medicare_enrollment_trend` | Show annual Medicare enrollment and Medicare Advantage/other, Original Medicare, Part D PDP, Part D MA-PD, and dual-eligible counts nationally or for one state. Enrollment counts are program participation, not utilization or revenue. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "medicare-coverage": {
      "url": "https://gateway.pipeworx.io/medicare-coverage/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Medicare Coverage data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
