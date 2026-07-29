# mcp-medicare-coverage

Medicare coverage policy from CMS: national and local coverage determinations, plus open analyses

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1366+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1366+ data sources:

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

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
