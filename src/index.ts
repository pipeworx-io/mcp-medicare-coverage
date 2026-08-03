interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */
const MAX_DETAIL = 300;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(`${name}: ${res.status}${detailSuffix(await readDetail(res))}`);
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  return `${name}: ${res.status}${detailSuffix(await readDetail(res))}`;
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an HTML page instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. First 120 chars: ${collapse(raw).slice(0, 120)}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `First 120 chars: ${collapse(raw).slice(0, 120)}`,
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  if (!raw) return '';

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) carries no API-level explanation, only markup that would crowd out
  // the status. Recognising it is worth more than stripping it: dropping it
  // keeps the message honest instead of filling it with `<!DOCTYPE html><html>`.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml')) return '';

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return collapse(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}


/** Medicare national and local coverage policy from the official CMS Coverage API. */

const BASE = 'https://api.coverage.cms.gov/v1';
const CMS_DATA = 'https://data.cms.gov/data-api/v1';
const CMS_CATALOG = 'https://data.cms.gov/data.json';
const MAX_BYTES = 6_000_000;
const listSchema = (key: string) => ({
  type: 'object', properties: {
    total: { type: 'number' }, returned: { type: 'number' },
    [key]: { type: 'array', items: { type: 'object' } },
    source: { type: 'string' }, interpretation: { type: 'string' },
  }, required: ['total', 'returned', key, 'source', 'interpretation'],
});

const tools: McpToolExport['tools'] = [
  {
    name: 'medicare_ncd_search',
    description: 'Search current Medicare National Coverage Determinations (NCDs) by title, benefit category, or NCD number. NCDs describe national Medicare policy; they are not individualized coverage guarantees or medical advice.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Title/topic text or NCD number, e.g. "amyloid" or "220.6.20". Terms are matched against CMS\'s formal titles, which spell acronyms out — search "positron tomography", not "PET".' },
      limit: { type: 'number', description: 'Results (1-100, default 25).' },
    }, required: ['query'] },
    outputSchema: listSchema('documents'),
  },
  {
    name: 'medicare_ncd_detail',
    description: 'Retrieve one official Medicare National Coverage Determination by CMS document ID and optional version, including covered indications, limitations, effective dates, benefit category, and revision text.',
    inputSchema: { type: 'object', properties: {
      document_id: { type: 'string', description: 'CMS NCD document ID returned by medicare_ncd_search.' },
      version: { type: 'number', description: 'Optional document version.' },
    }, required: ['document_id'] },
    outputSchema: { type: 'object', properties: {
      document_id: { type: 'string' }, title: { type: 'string' },
      effective_date: { type: 'string' }, indications_limitations: { type: 'string' },
      source_url: { type: 'string' }, interpretation: { type: 'string' },
    }, required: ['document_id', 'title', 'source_url', 'interpretation'] },
  },
  {
    name: 'medicare_lcd_search',
    description: 'Search current final Medicare Local Coverage Determinations (LCDs), optionally restricted to a state. LCDs are contractor- and jurisdiction-specific and can differ across locations.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Policy title/topic or LCD number.' },
      state: { type: 'string', description: 'Optional US state name or two-letter abbreviation. California, New York and Missouri span multiple MAC jurisdictions; those resolve to the whole-state jurisdiction and the response reports which one under state_resolved.' },
      status: { type: 'string', description: 'Optional CMS status filter.' },
      limit: { type: 'number', description: 'Results (1-100, default 25).' },
    }, required: ['query'] },
    outputSchema: listSchema('documents'),
  },
  {
    name: 'medicare_lcd_detail',
    description: 'Retrieve one Medicare LCD by document ID and version. Detailed LCD text requires a CMS license-agreement bearer token because documents may contain licensed AMA/ADA/AHA material; pass _licenseToken obtained directly from CMS after accepting those terms.',
    inputSchema: { type: 'object', properties: {
      document_id: { type: 'string' }, version: { type: 'number' },
      _licenseToken: { type: 'string', description: 'CMS Coverage API license token, valid for one hour.' },
    }, required: ['document_id', '_licenseToken'] },
    outputSchema: { type: 'object', properties: {
      document_id: { type: 'string' }, title: { type: 'string' },
      source_url: { type: 'string' }, interpretation: { type: 'string' },
    }, required: ['document_id', 'title', 'source_url', 'interpretation'] },
  },
  {
    name: 'medicare_nca_search',
    description: 'Search National Coverage Analyses (NCAs) and Coverage Analyses for Labs (CALs), including open and completed CMS evidence reviews. An open analysis is a policy process, not a coverage decision.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Topic, title, or tracking number.' },
      status: { type: 'string', description: 'Optional exact status, e.g. Open.' },
      limit: { type: 'number' },
    }, required: ['query'] },
    outputSchema: listSchema('analyses'),
  },
  {
    name: 'medicare_nca_detail',
    description: 'Retrieve one CMS National Coverage Analysis by document ID, including request, issue, benefit category, dates, decision memo, and public-comment status when supplied by CMS.',
    inputSchema: { type: 'object', properties: {
      document_id: { type: 'string', description: 'CMS NCA document ID.' },
    }, required: ['document_id'] },
    outputSchema: { type: 'object', properties: {
      document_id: { type: 'string' }, title: { type: 'string' },
      source_url: { type: 'string' }, interpretation: { type: 'string' },
    }, required: ['document_id', 'title', 'source_url', 'interpretation'] },
  },
  {
    name: 'medicare_recent_coverage_changes',
    description: 'Recently published or updated national Medicare coverage documents from CMS, including NCDs, NCAs, CALs, MEDCAC meetings, and technology assessments.',
    inputSchema: { type: 'object', properties: {
      days: { type: 'number', description: 'Look-back window (1-365, default 30).' },
      document_type: { type: 'string', description: 'Optional case-sensitive CMS document type, e.g. NCD or NCA.' },
      limit: { type: 'number' },
    }},
    outputSchema: listSchema('changes'),
  },
  {
    name: 'medicare_coverage_states',
    description: 'List CMS Coverage API state identifiers used to scope local Medicare coverage searches.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: listSchema('states'),
  },
  {
    name: 'medicare_article_code_profile',
    description: 'Retrieve one CMS Medicare Coverage Article with its CPT/HCPCS codes and contractor records. Licensed AMA/ADA/AHA content requires a caller-provided CMS license token. Code inclusion describes billing guidance, not guaranteed coverage or payment.',
    inputSchema: { type: 'object', properties: {
      article_id: { type: 'string', description: 'CMS article ID, with or without A prefix.' },
      version: { type: 'number' }, _licenseToken: { type: 'string', description: 'CMS license-agreement bearer token.' },
      limit: { type: 'number', description: 'Code rows (1-200, default 100).' },
    }, required: ['article_id', '_licenseToken'] },
    outputSchema: { type: 'object', properties: {
      article: { type: 'object' }, codes: { type: 'array', items: { type: 'object' } },
      contractors: { type: 'array', items: { type: 'object' } }, source: { type: 'string' },
      interpretation: { type: 'string' },
    }, required: ['article', 'codes', 'contractors', 'source', 'interpretation'] },
  },
  {
    name: 'medicare_local_coverage_variation',
    description: 'Compare final LCD search matches across 1–15 states and Medicare Administrative Contractors. Different matching document counts or titles are policy signals, not proof of unequal beneficiary access or payment.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' }, states: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 15 },
      status: { type: 'string' }, limit_per_state: { type: 'number', description: 'Documents per state (1-25, default 10).' },
    }, required: ['query', 'states'] },
    outputSchema: { type: 'object', properties: {
      query: { type: 'string' }, states: { type: 'array', items: { type: 'object' } },
      interpretation: { type: 'string' }, source: { type: 'string' },
    }, required: ['query', 'states', 'interpretation', 'source'] },
  },
  {
    name: 'medicare_coverage_timeline',
    description: 'Retrieve official CMS version or revision history for a Medicare NCD, NCA, CAL, or LCD. Accepts either identifier CMS publishes for a coverage document: the public one that appears in the policy text and in every citation of it — an NCD section number such as 310.1 or 90.2, an NCA/CAL tracking number such as CAG-00450N, an LCD number such as L34246 — or CMS\'s internal numeric document id. Public identifiers are resolved to the internal id automatically, and every response reports the resolved internal document_id alongside the public document_display_id and the document title so a caller can confirm the policy matches the one they asked about. LCD revision history requires a caller-supplied CMS license token. Timeline entries describe policy publication and revision history; utilization, payment, and claim-level adjudication come from other tools.',
    inputSchema: { type: 'object', properties: {
      document_type: { type: 'string', enum: ['NCD', 'NCA', 'CAL', 'LCD'] },
      document_id: { type: 'string', description: 'Either the public identifier (NCD section number like "310.1", NCA/CAL tracking number like "CAG-00450N", LCD number like "L34246") or CMS\'s internal numeric document id. A leading "NCD "/"NCA "/"CAL "/"LCD " word is accepted and ignored. A digits-only value is read as the internal id: CMS numbers the two identifier spaces independently, so internal id 90 is the policy published as NCD 190.18, while NCD 90.2 is internal id 372.' },
      version: { type: 'number', description: 'Optional LCD version.' },
      _licenseToken: { type: 'string', description: 'Required only for LCD.' },
    }, required: ['document_type', 'document_id'] },
    outputSchema: { type: 'object', properties: {
      found: { type: 'boolean' }, document_type: { type: 'string' },
      requested_document_id: { type: 'string', description: 'Exactly what the caller passed.' },
      document_id: { type: ['string', 'null'], description: 'CMS internal id the request actually resolved to.' },
      document_display_id: { type: ['string', 'null'], description: 'Public identifier of the resolved document.' },
      title: { type: ['string', 'null'] }, cms_document_type: { type: ['string', 'null'] },
      resolved_by: { type: 'string' }, reason: { type: 'string' }, hint: { type: 'string' },
      candidates: { type: 'array', items: { type: 'object' } },
      total: { type: 'number' }, returned: { type: 'number' },
      timeline: { type: 'array', items: { type: 'object' } },
      source: { type: 'string' }, interpretation: { type: 'string' },
    }, required: ['found', 'document_type', 'requested_document_id', 'document_id', 'document_display_id', 'title', 'source', 'interpretation'] },
  },
  {
    name: 'medicare_hcpcs_utilization_trend',
    description: 'Show annual Medicare Physician & Other Practitioners national utilization and payment metrics for one HCPCS code. Claims are fee-for-service aggregates with suppression and methodology limits; they do not measure total US use, coverage, demand, or company revenue.',
    inputSchema: { type: 'object', properties: {
      hcpcs_code: { type: 'string' }, from_year: { type: 'number' }, to_year: { type: 'number' },
    }, required: ['hcpcs_code'] },
    outputSchema: { type: 'object', properties: {
      hcpcs_code: { type: 'string' }, years: { type: 'array', items: { type: 'object' } },
      interpretation: { type: 'string' }, source: { type: 'string' },
    }, required: ['hcpcs_code', 'years', 'interpretation', 'source'] },
  },
  {
    name: 'medicare_hcpcs_geography',
    description: 'Compare state-level Medicare fee-for-service provider, beneficiary, service, and average-payment metrics for one HCPCS code and program year. State beneficiary counts across places of service must not be summed as unique people.',
    inputSchema: { type: 'object', properties: {
      hcpcs_code: { type: 'string' }, year: { type: 'number' }, limit: { type: 'number', description: 'State/place rows (1-120, default 120).' },
    }, required: ['hcpcs_code'] },
    outputSchema: listSchema('geographies'),
  },
  {
    name: 'medicare_provider_exposure',
    description: 'Return a bounded sample of provider-level Medicare fee-for-service rows for one HCPCS code, optionally filtered by state, with the authoritative matching-row count. This is not a provider ranking and excludes suppressed/non-FFS activity.',
    inputSchema: { type: 'object', properties: {
      hcpcs_code: { type: 'string' }, state: { type: 'string' }, year: { type: 'number' },
      limit: { type: 'number', description: 'Sample rows (1-100, default 25).' }, offset: { type: 'number' },
    }, required: ['hcpcs_code'] },
    outputSchema: { type: 'object', properties: {
      hcpcs_code: { type: 'string' }, year: { type: 'number' }, matching_rows: { type: 'number' },
      returned: { type: 'number' }, providers: { type: 'array', items: { type: 'object' } },
      interpretation: { type: 'string' }, source: { type: 'string' },
    }, required: ['hcpcs_code', 'year', 'matching_rows', 'returned', 'providers', 'interpretation', 'source'] },
  },
  {
    name: 'medicare_product_market_profile',
    description: 'Combine national coverage-policy matches with annual Medicare fee-for-service utilization for a product/topic and caller-supplied HCPCS codes. CMS does not validate the product-to-code association; verify coding and policy details independently.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Product, technology, or clinical topic.' },
      hcpcs_codes: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
      from_year: { type: 'number' }, to_year: { type: 'number' }, policy_limit: { type: 'number' },
    }, required: ['query', 'hcpcs_codes'] },
    outputSchema: { type: 'object', properties: {
      query: { type: 'string' }, hcpcs_codes: { type: 'array', items: { type: 'object' } },
      national_policy: { type: 'object' }, interpretation: { type: 'string' },
    }, required: ['query', 'hcpcs_codes', 'national_policy', 'interpretation'] },
  },
  {
    name: 'medicare_part_d_drug_spending',
    description: 'Search CMS Medicare Part D spending by brand or generic name and return 2020–2024 spending, claims, beneficiaries, dosage units, and unit-cost trends. Gross Part D spending is not manufacturer revenue, net price, profit, prescriptions, or total US sales.',
    inputSchema: { type: 'object', properties: {
      drug: { type: 'string' },
      limit: { type: 'number', description: 'Rows (1-100, default 25).' }, offset: { type: 'number' },
    }, required: ['drug'] },
    outputSchema: listSchema('drugs'),
  },
  {
    name: 'medicare_part_d_prescriber_exposure',
    description: 'Return a bounded sample of Medicare Part D prescriber-by-drug rows for an exact brand name in one year, optionally filtered by state, with the authoritative matching-row count. This is not a prescriber ranking and suppressed/non-Part-D activity is absent.',
    inputSchema: { type: 'object', properties: {
      brand_name: { type: 'string' }, state: { type: 'string' }, year: { type: 'number' },
      limit: { type: 'number' }, offset: { type: 'number' },
    }, required: ['brand_name'] },
    outputSchema: { type: 'object', properties: {
      brand_name: { type: 'string' }, year: { type: 'number' }, matching_rows: { type: 'number' },
      returned: { type: 'number' }, prescribers: { type: 'array', items: { type: 'object' } },
      source: { type: 'string' }, interpretation: { type: 'string' },
    }, required: ['brand_name', 'year', 'matching_rows', 'returned', 'prescribers', 'source', 'interpretation'] },
  },
  {
    name: 'medicare_part_d_generic_competition',
    description: 'Profile Medicare Part D brand rows sharing an exact generic name, including CMS’s reported manufacturer count and 2020–2024 spending/use trends. Manufacturer count is a CMS aggregate, not a list of companies, products on market, or market share.',
    inputSchema: { type: 'object', properties: {
      generic_name: { type: 'string' }, limit: { type: 'number', description: 'Brand rows (1-100, default 50).' },
    }, required: ['generic_name'] },
    outputSchema: { type: 'object', properties: {
      generic_name: { type: 'string' }, matching_rows: { type: 'number' }, returned: { type: 'number' },
      brands: { type: 'array', items: { type: 'object' } }, reported_manufacturer_count: { type: 'number' },
      source: { type: 'string' }, interpretation: { type: 'string' },
    }, required: ['generic_name', 'matching_rows', 'returned', 'brands', 'reported_manufacturer_count', 'source', 'interpretation'] },
  },
  {
    name: 'medicare_inpatient_drg_market',
    description: 'Return a bounded sample of hospital-level Medicare fee-for-service inpatient rows for an exact MS-DRG and year, optionally filtered by state, with the authoritative matching-row count. Average payments are not hospital revenue or margin.',
    inputSchema: { type: 'object', properties: {
      drg_code: { type: 'string' }, state: { type: 'string' }, year: { type: 'number' },
      limit: { type: 'number' }, offset: { type: 'number' },
    }, required: ['drg_code'] },
    outputSchema: listSchema('hospitals'),
  },
  {
    name: 'medicare_outpatient_apc_market',
    description: 'Return a bounded sample of hospital-level Medicare fee-for-service outpatient rows for an exact APC and year, optionally filtered by state, with the authoritative matching-row count. APC payments are claims aggregates, not hospital revenue or margin.',
    inputSchema: { type: 'object', properties: {
      apc_code: { type: 'string' }, state: { type: 'string' }, year: { type: 'number' },
      limit: { type: 'number' }, offset: { type: 'number' },
    }, required: ['apc_code'] },
    outputSchema: listSchema('hospitals'),
  },
  {
    name: 'medicare_hospital_service_trend',
    description: 'Show annual national Medicare fee-for-service utilization and average-payment trends for one inpatient MS-DRG or outpatient APC using CMS geography/service aggregates. Trends exclude Medicare Advantage and do not measure total market demand, revenue, or profitability.',
    inputSchema: { type: 'object', properties: {
      service_type: { type: 'string', enum: ['Inpatient DRG', 'Outpatient APC'] },
      code: { type: 'string' }, from_year: { type: 'number' }, to_year: { type: 'number' },
    }, required: ['service_type', 'code'] },
    outputSchema: { type: 'object', properties: {
      service_type: { type: 'string' }, code: { type: 'string' }, years: { type: 'array', items: { type: 'object' } },
      source: { type: 'string' }, interpretation: { type: 'string' },
    }, required: ['service_type', 'code', 'years', 'source', 'interpretation'] },
  },
  {
    name: 'medicare_dme_supplier_market',
    description: 'Return a bounded API-order sample of Medicare fee-for-service DME supplier rows for an exact HCPCS code and year, optionally filtered by state, with the authoritative matching-row count. This is not a supplier ranking or total market size.',
    inputSchema: { type: 'object', properties: {
      hcpcs_code: { type: 'string' }, state: { type: 'string' }, year: { type: 'number' },
      limit: { type: 'number' }, offset: { type: 'number' },
    }, required: ['hcpcs_code'] },
    outputSchema: listSchema('suppliers'),
  },
  {
    name: 'medicare_dme_service_trend',
    description: 'Show annual national Medicare fee-for-service DME supplier, beneficiary, claim, service, and average-payment metrics for one HCPCS code. It excludes Medicare Advantage and is not total market demand or company revenue.',
    inputSchema: { type: 'object', properties: {
      hcpcs_code: { type: 'string' }, from_year: { type: 'number' }, to_year: { type: 'number' },
    }, required: ['hcpcs_code'] },
    outputSchema: { type: 'object', properties: {
      hcpcs_code: { type: 'string' }, years: { type: 'array', items: { type: 'object' } },
      source: { type: 'string' }, interpretation: { type: 'string' },
    }, required: ['hcpcs_code', 'years', 'source', 'interpretation'] },
  },
  {
    name: 'medicare_post_acute_provider_market',
    description: 'Return a bounded API-order sample of Medicare post-acute provider rows for home health, hospice, or skilled nursing in one year and optional state, with the authoritative matching-row count. Payments are not provider revenue or margin.',
    inputSchema: { type: 'object', properties: {
      service_type: { type: 'string', enum: ['Home Health', 'Hospice', 'Skilled Nursing'] },
      state: { type: 'string' }, year: { type: 'number' }, limit: { type: 'number' }, offset: { type: 'number' },
    }, required: ['service_type'] },
    outputSchema: listSchema('providers'),
  },
  {
    name: 'medicare_post_acute_trend',
    description: 'Show annual national Medicare fee-for-service beneficiaries, stays, service days, and payments for home health, hospice, or skilled nursing. Program definitions and year basis differ by service and the figures are not provider revenue.',
    inputSchema: { type: 'object', properties: {
      service_type: { type: 'string', enum: ['Home Health', 'Hospice', 'Skilled Nursing'] },
      from_year: { type: 'number' }, to_year: { type: 'number' },
    }, required: ['service_type'] },
    outputSchema: { type: 'object', properties: {
      service_type: { type: 'string' }, years: { type: 'array', items: { type: 'object' } },
      source: { type: 'string' }, interpretation: { type: 'string' },
    }, required: ['service_type', 'years', 'source', 'interpretation'] },
  },
  {
    name: 'medicare_enrollment_trend',
    description: 'Show annual Medicare enrollment and Medicare Advantage/other, Original Medicare, Part D PDP, Part D MA-PD, and dual-eligible counts nationally or for one state. Enrollment counts are program participation, not utilization or revenue.',
    inputSchema: { type: 'object', properties: {
      state: { type: 'string', description: 'Optional two-letter state abbreviation; omit for national.' },
      from_year: { type: 'number' }, to_year: { type: 'number' },
    }},
    outputSchema: { type: 'object', properties: {
      geography: { type: 'string' }, years: { type: 'array', items: { type: 'object' } },
      source: { type: 'string' }, interpretation: { type: 'string' },
    }, required: ['geography', 'years', 'source', 'interpretation'] },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'medicare_ncd_search': return searchNcd(args);
    case 'medicare_ncd_detail': return ncdDetail(args);
    case 'medicare_lcd_search': return searchLcd(args);
    case 'medicare_lcd_detail': return lcdDetail(args);
    case 'medicare_nca_search': return searchNca(args);
    case 'medicare_nca_detail': return ncaDetail(args);
    case 'medicare_recent_coverage_changes': return recentChanges(args);
    case 'medicare_coverage_states': return listStates();
    case 'medicare_article_code_profile': return articleCodeProfile(args);
    case 'medicare_local_coverage_variation': return localCoverageVariation(args);
    case 'medicare_coverage_timeline': return coverageTimeline(args);
    case 'medicare_hcpcs_utilization_trend': return hcpcsTrend(args);
    case 'medicare_hcpcs_geography': return hcpcsGeography(args);
    case 'medicare_provider_exposure': return providerExposure(args);
    case 'medicare_product_market_profile': return productMarketProfile(args);
    case 'medicare_part_d_drug_spending': return partDDrugSpending(args);
    case 'medicare_part_d_prescriber_exposure': return partDPrescriberExposure(args);
    case 'medicare_part_d_generic_competition': return partDGenericCompetition(args);
    case 'medicare_inpatient_drg_market': return hospitalMarket(args, 'inpatient');
    case 'medicare_outpatient_apc_market': return hospitalMarket(args, 'outpatient');
    case 'medicare_hospital_service_trend': return hospitalServiceTrend(args);
    case 'medicare_dme_supplier_market': return dmeSupplierMarket(args);
    case 'medicare_dme_service_trend': return dmeServiceTrend(args);
    case 'medicare_post_acute_provider_market': return postAcuteProviderMarket(args);
    case 'medicare_post_acute_trend': return postAcuteTrend(args);
    case 'medicare_enrollment_trend': return enrollmentTrend(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function searchNcd(args: Record<string, unknown>) {
  const query = requiredString(args, 'query').toLowerCase();
  const payload = await cms('/reports/national-coverage-ncd/');
  const all = rows(payload).filter((row) => includesAny(row, query,
    ['title', 'document_display_id', 'chapter', 'document_type']));
  return listResult('documents', all.slice(0, limitArg(args)), all.length, nationalInterpretation());
}

async function ncdDetail(args: Record<string, unknown>) {
  const id = idArg(args.document_id);
  const version = optionalPositiveInt(args.version);
  const payload = await cms('/data/ncd/', compact({ ncdid: id, ncdver: version }));
  const row = rows(payload)[0];
  if (!row) throw new Error(`NCD ${id} was not found.`);
  return {
    ...cleanObject(row),
    item_service_description: cleanHtml(row.item_service_description),
    indications_limitations: cleanHtml(row.indications_limitations),
    reasons_for_denial: cleanHtml(row.reasons_for_denial),
    revision_history: cleanHtml(row.revision_history),
    source_url: `https://www.cms.gov/medicare-coverage-database/view/ncd.aspx?ncdid=${encodeURIComponent(id)}${version ? `&ncdver=${version}` : ''}`,
    source: source(),
    interpretation: nationalInterpretation(),
  };
}

async function searchLcd(args: Record<string, unknown>) {
  const query = requiredString(args, 'query').toLowerCase();
  const state = stringArg(args.state);
  const resolved = state ? await resolveState(state) : null;
  const payload = await cms('/reports/local-coverage-final-lcds/', compact({
    state_id: resolved?.id, status: stringArg(args.status),
  }));
  const all = rows(payload).filter((row) =>
    includesAny(row, query, ['title', 'document_display_id', 'contractor_name_type']));
  return {
    ...listResult('documents', all.slice(0, limitArg(args)), all.length, localInterpretation()),
    // Say which CMS jurisdiction the request actually landed in — asking for
    // "CA" resolves to "California - Entire State", and a caller comparing
    // results across states needs to know that rather than assume it.
    ...(resolved ? { state_resolved: resolved.description } : {}),
  };
}

async function lcdDetail(args: Record<string, unknown>) {
  const id = idArg(args.document_id);
  const token = requiredString(args, '_licenseToken');
  const version = optionalPositiveInt(args.version);
  const payload = await cms('/data/lcd/', compact({ lcdid: id, ver: version }), token);
  const row = rows(payload)[0];
  if (!row) throw new Error(`LCD ${id} was not found.`);
  return {
    ...Object.fromEntries(Object.entries(cleanObject(row)).map(([key, value]) =>
      [key, typeof value === 'string' ? cleanHtml(value) : value])),
    source_url: `https://www.cms.gov/medicare-coverage-database/view/lcd.aspx?lcdid=${encodeURIComponent(id)}${version ? `&ver=${version}` : ''}`,
    source: source(),
    interpretation: localInterpretation(),
  };
}

async function searchNca(args: Record<string, unknown>) {
  const query = requiredString(args, 'query').toLowerCase();
  const status = stringArg(args.status)?.toLowerCase();
  const payload = await cms('/reports/national-coverage-ncacal/');
  const all = rows(payload).filter((row) =>
    includesAny(row, query, ['title', 'document_display_id', 'review_type', 'document_type'])
    && (!status || String(row.document_status ?? '').toLowerCase() === status));
  return listResult('analyses', all.slice(0, limitArg(args)), all.length, analysisInterpretation());
}

async function ncaDetail(args: Record<string, unknown>) {
  const id = idArg(args.document_id);
  const payload = await cms('/data/nca/', { ncaid: id });
  const row = rows(payload)[0];
  if (!row) throw new Error(`NCA ${id} was not found.`);
  return {
    ...Object.fromEntries(Object.entries(cleanObject(row)).map(([key, value]) =>
      [key, typeof value === 'string' ? cleanHtml(value) : value])),
    source_url: `https://www.cms.gov/medicare-coverage-database/view/ncacal-tracking-sheet.aspx?ncaid=${encodeURIComponent(id)}`,
    source: source(),
    interpretation: analysisInterpretation(),
  };
}

async function recentChanges(args: Record<string, unknown>) {
  const days = intArg(args.days, 30, 1, 365);
  const type = stringArg(args.document_type);
  const payload = await cms('/reports/whats-new/national/', compact({
    timeframe: days, document_type: type,
  }));
  const all = rows(payload);
  return listResult('changes', all.slice(0, limitArg(args)), all.length, analysisInterpretation());
}

async function listStates() {
  const payload = await cms('/metadata/states/');
  const states = rows(payload);
  return listResult('states', states, states.length, localInterpretation());
}

async function articleCodeProfile(args: Record<string, unknown>) {
  const articleId = prefixedId(requiredString(args, 'article_id'), 'A');
  const version = optionalPositiveInt(args.version);
  const token = requiredString(args, '_licenseToken');
  const common = compact({ articleid: articleId.replace(/^A/i, ''), ver: version });
  const [articlePayload, codePayload, contractorPayload] = await Promise.all([
    cms('/data/article/', common, token),
    cms('/data/article/hcpc-code', { ...common, page_size: intArg(args.limit, 100, 1, 200) }, token),
    cms('/data/article/contractor', common, token),
  ]);
  const article = rows(articlePayload)[0];
  if (!article) throw new Error(`Article ${articleId} was not found.`);
  return {
    article: cleanObject(article),
    codes: rows(codePayload).map(cleanObject),
    contractors: rows(contractorPayload).map(cleanObject),
    source: source(),
    interpretation: 'Article code rows are CMS billing guidance under the article and may include CPT content subject to license terms. A listed code does not guarantee coverage or payment; apply the article text, linked LCD, modifiers, dates, setting, and claim-specific requirements.',
  };
}

async function localCoverageVariation(args: Record<string, unknown>) {
  const query = requiredString(args, 'query');
  const requested = stringArray(args.states, 'states', 1, 15);
  const stateRows = rows(await cms('/metadata/states/'));
  const resolved = requested.map((value) => resolveStateFromRows(value, stateRows));
  const limit = intArg(args.limit_per_state, 10, 1, 25);
  const results = await Promise.all(resolved.map(async (state) => {
    const payload = await cms('/reports/local-coverage-final-lcds/', compact({
      state_id: state.id, status: stringArg(args.status),
    }));
    const matching = rows(payload).filter((row) =>
      includesAny(row, query.toLowerCase(), ['title', 'document_display_id', 'contractor_name_type']));
    return {
      requested_state: state.description,
      matching_documents: matching.length,
      contractors: [...new Set(matching.map((row) =>
        String(row.contractor_name_type ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))],
      documents: matching.slice(0, limit).map(cleanObject),
    };
  }));
  return {
    query, states: results, source: source(),
    interpretation: 'This compares matching final-LCD report rows by state. Document counts and titles can differ because of contractor jurisdictions, policy versions, and search wording; they do not prove coverage, payment, or unequal beneficiary access.',
  };
}

// CMS gives every coverage document two unrelated identifiers: the internal
// numeric `document_id` its API takes as a parameter, and the
// `document_display_id` printed in the policy itself and used in every
// citation of it (NCD 310.1, CAG-00450N, L34246). The numbering schemes are
// independent — internal id 90 is the policy published as NCD 190.18 "Serum
// Iron Studies", while the policy published as NCD 90.2 is internal id 372.
// Accepting digits only meant an agent holding the identifier people actually
// have either hit a dead end or, worse, stripped the dot, passed "90", and got
// an unrelated policy back with its own input echoed as `document_id` — a
// confidently wrong coverage answer with nothing in the payload to reveal the
// substitution. So: resolve both directions, and always report what we landed
// on rather than what was asked for.
const NCD_REPORT = '/reports/national-coverage-ncd/';
const NCACAL_REPORT = '/reports/national-coverage-ncacal/';
const LCD_REPORT = '/reports/local-coverage-final-lcds/';
const TWO_ID_SPACES = 'CMS identifies each coverage document twice: a public document_display_id printed in the policy and used in its citations (NCD section numbers such as 310.1, NCA/CAL tracking numbers such as CAG-00450N, LCD numbers such as L34246), and an internal numeric document_id that the Coverage API accepts as a parameter. The two numbering schemes are independent, so the digits of one identifier address a different policy in the other. Look the document up by title with medicare_ncd_search, medicare_nca_search, or medicare_lcd_search and read document_id from the matching row.';
const TIMELINE_INTERPRETATION = 'Timeline entries are CMS publication, version, or revision history for the single document named by document_id. Confirm document_display_id and title match the policy you meant before relying on the result. Claim-level adjudication, utilization, and payment are measured by separate tools, and related policies filed under other identifiers appear under their own timelines.';

type CoverageIdentity = {
  document_id: string;
  document_display_id: string | null;
  title: string | null;
  cms_document_type: string | null;
};

async function coverageTimeline(args: Record<string, unknown>) {
  const type = requiredString(args, 'document_type').toUpperCase();
  if (type !== 'NCD' && type !== 'NCA' && type !== 'CAL' && type !== 'LCD') {
    throw new Error('document_type must be NCD, NCA, CAL, or LCD');
  }
  const requested = requiredString(args, 'document_id');
  const version = optionalPositiveInt(args.version);
  const token = type === 'LCD' ? requiredString(args, '_licenseToken') : undefined;
  const parsed = parseTimelineIdentifier(requested, type);
  if (parsed.kind === 'unknown') {
    return timelineMiss(type, requested, {}, 'display_id_not_resolvable',
      `"${requested}" matches neither identifier CMS uses for ${article(type)}. ${TWO_ID_SPACES}`);
  }

  let id: string;
  let resolved: CoverageIdentity | null = null;
  if (parsed.kind === 'internal') {
    id = parsed.id;
  } else {
    const candidates = await resolveDisplayId(type, parsed.display);
    if (candidates.length === 0) {
      return timelineMiss(type, requested, { document_display_id: parsed.display }, 'display_id_not_resolvable',
        `CMS's current ${type === 'NCD' ? 'national coverage NCD' : 'NCA/CAL'} report lists no document with display id ${parsed.display}. ${TWO_ID_SPACES}`);
    }
    if (candidates.length > 1) {
      return {
        ...timelineMiss(type, requested, { document_display_id: parsed.display }, 'display_id_ambiguous',
          `Display id ${parsed.display} maps to ${candidates.length} CMS documents. Re-call with one of the internal document_id values listed in candidates.`),
        candidates,
      };
    }
    resolved = candidates[0];
    id = resolved.document_id;
  }

  let path: string; let params: Record<string, unknown>;
  if (type === 'NCD') {
    path = '/data/ncd/other-versions/'; params = { ncdid: id };
  } else if (type === 'NCA') {
    path = '/data/nca/history'; params = { ncaid: id };
  } else if (type === 'CAL') {
    // CMS names this parameter calid; sending ncaid made every CAL timeline
    // 400 with "invalid calid" for the life of this tool.
    path = '/data/cal/history'; params = { calid: id };
  } else {
    path = '/data/lcd/revision-history'; params = compact({ lcdid: id, ver: version });
  }
  const rawRows = rows(await cms(path, params, token));
  const identity = await timelineIdentity(type, id, rawRows, resolved);
  if (rawRows.length === 0) {
    // An empty data array reads as "this policy was never revised" unless we
    // say otherwise; CMS returns exactly that for an id it does not have.
    return timelineMiss(type, requested, identity, 'document_not_found',
      `CMS returned no ${type} history for internal document_id ${id}. Confirm that id addresses ${article(type)}. ${TWO_ID_SPACES}`);
  }
  const timeline = rawRows.map((row) =>
    Object.fromEntries(Object.entries(cleanObject(row)).map(([key, value]) =>
      [key, typeof value === 'string' ? cleanHtml(value) : value])));
  return {
    ...timelineBase(type, requested, identity),
    found: true,
    resolved_by: parsed.kind === 'internal' ? 'internal document_id' : 'public document_display_id',
    total: timeline.length, returned: timeline.length, timeline,
    interpretation: TIMELINE_INTERPRETATION,
  };
}

function timelineBase(type: string, requested: string, identity: Partial<CoverageIdentity>) {
  return {
    document_type: type,
    requested_document_id: requested,
    document_id: identity.document_id ?? null,
    document_display_id: identity.document_display_id ?? null,
    title: identity.title ?? null,
    cms_document_type: identity.cms_document_type ?? null,
    source: source(),
  };
}

function timelineMiss(type: string, requested: string, identity: Partial<CoverageIdentity>, reason: string, hint: string) {
  return {
    ...timelineBase(type, requested, identity),
    found: false, reason, hint, timeline: [], total: 0, returned: 0,
    interpretation: TIMELINE_INTERPRETATION,
  };
}

// A leading type word is how people write these ("NCD 310.1", "CAL CAG-00285N"),
// and it carries no information the document_type argument lacks.
function parseTimelineIdentifier(raw: string, type: string):
  { kind: 'internal'; id: string } | { kind: 'display'; display: string } | { kind: 'unknown' } {
  const value = raw.trim().replace(/^(NCD|NCA|CAL|LCD)\b[\s:#-]*/i, '').trim();
  if (/^\d+$/.test(value)) return { kind: 'internal', id: value };
  // An LCD's display id is literally "L" plus its internal id, so it needs no lookup.
  if (type === 'LCD' && /^L\d+$/i.test(value)) return { kind: 'internal', id: value.slice(1) };
  if (type === 'NCD' && /^\d+(?:\.\d+)+$/.test(value)) return { kind: 'display', display: value };
  if ((type === 'NCA' || type === 'CAL') && /^CAG-?\d{3,}[A-Z]?\d*$/i.test(value)) {
    const upper = value.toUpperCase();
    return { kind: 'display', display: upper.startsWith('CAG-') ? upper : `CAG-${upper.slice(3)}` };
  }
  return { kind: 'unknown' };
}

// NCAs and CALs share one report and one numbering space, so a tracking number
// is looked up across both and the type CMS actually assigned comes back with it.
async function resolveDisplayId(type: string, display: string): Promise<CoverageIdentity[]> {
  const report = type === 'NCD' ? NCD_REPORT : NCACAL_REPORT;
  const wanted = display.toUpperCase();
  const byId = new Map<string, CoverageIdentity>();
  for (const row of rows(await cms(report))) {
    if (String(row.document_display_id ?? '').trim().toUpperCase() !== wanted) continue;
    const id = String(row.document_id ?? '').trim();
    // CMS files some tracking numbers twice under one document_id (a renamed
    // sheet); that is one document, not an ambiguous match.
    if (id && !byId.has(id)) {
      byId.set(id, {
        document_id: id,
        document_display_id: stringOrNull(row.document_display_id),
        title: stringOrNull(row.title),
        cms_document_type: stringOrNull(row.document_type),
      });
    }
  }
  return [...byId.values()];
}

async function timelineIdentity(
  type: string, id: string, rawRows: Array<Record<string, unknown>>, resolved: CoverageIdentity | null,
): Promise<CoverageIdentity> {
  if (type === 'LCD') return lcdIdentity(id);
  // NCA/CAL history lists every document on the same tracking sheet, so row 0
  // is often a *sibling* — asking for 296 (CAG-00450R) returns 290
  // (CAG-00450N) first. Naming the document from row 0 would reintroduce the
  // exact mislabelling this tool is being fixed for, so match on the id we
  // actually requested and only fall back to the head of the list.
  const self = rawRows.find((row) => String(row.document_id ?? '').trim() === id) ?? rawRows[0] ?? {};
  // The history rows already carry the document's public id and title — NCD
  // versions call it `section`, NCA/CAL history calls it `document_display_id`
  // — so the common internal-id path costs no extra request.
  const identity: CoverageIdentity = {
    document_id: id,
    document_display_id: resolved?.document_display_id
      ?? stringOrNull(type === 'NCD' ? self.section : self.document_display_id),
    title: resolved?.title ?? stringOrNull(self.title),
    cms_document_type: resolved?.cms_document_type ?? null,
  };
  if (type === 'NCD' && !identity.document_display_id && rawRows.length) {
    const match = rows(await cms(NCD_REPORT)).find((row) => String(row.document_id ?? '').trim() === id);
    if (match) {
      identity.document_display_id = stringOrNull(match.document_display_id);
      identity.title = identity.title ?? stringOrNull(match.title);
      identity.cms_document_type = identity.cms_document_type ?? stringOrNull(match.document_type);
    }
  }
  return identity;
}

async function lcdIdentity(id: string): Promise<CoverageIdentity> {
  const match = rows(await cms(LCD_REPORT)).find((row) => String(row.document_id ?? '').trim() === id);
  return {
    document_id: id,
    document_display_id: stringOrNull(match?.document_display_id) ?? `L${id}`,
    title: stringOrNull(match?.title),
    cms_document_type: stringOrNull(match?.document_type) ?? 'LCD',
  };
}

function article(type: string) { return type === 'CAL' ? 'a CAL' : `an ${type}`; }

function stringOrNull(value: unknown): string | null {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text || null;
}

async function hcpcsTrend(args: Record<string, unknown>) {
  const code = hcpcsArg(args.hcpcs_code);
  const distributions = await utilizationDistributions('geography');
  const [from, to] = utilizationYearRange(args, distributions);
  const selected = distributions.filter((d) => d.year >= from && d.year <= to);
  const years = await Promise.all(selected.map(async (distribution) => {
    const data = await cmsDataRows(distribution.url, { HCPCS_Cd: code }, 10);
    const national = data.filter((row) => row.Rndrng_Prvdr_Geo_Lvl === 'National');
    return summarizeUtilizationYear(distribution.year, national, distribution);
  }));
  return {
    hcpcs_code: code, years, source: utilizationSource(),
    interpretation: utilizationInterpretation(),
  };
}

async function hcpcsGeography(args: Record<string, unknown>) {
  const code = hcpcsArg(args.hcpcs_code);
  const distributions = await utilizationDistributions('geography');
  const year = selectedYear(args.year, distributions);
  const distribution = distributions.find((d) => d.year === year)!;
  const all = await cmsDataRows(distribution.url, { HCPCS_Cd: code }, 200);
  const geographies = all.filter((row) => row.Rndrng_Prvdr_Geo_Lvl === 'State')
    .slice(0, intArg(args.limit, 120, 1, 120)).map(projectGeography);
  return {
    total: all.filter((row) => row.Rndrng_Prvdr_Geo_Lvl === 'State').length,
    returned: geographies.length, geographies, year, hcpcs_code: code,
    dataset: distribution, source: utilizationSource(), interpretation: utilizationInterpretation(),
  };
}

async function providerExposure(args: Record<string, unknown>) {
  const code = hcpcsArg(args.hcpcs_code);
  const distributions = await utilizationDistributions('provider');
  const year = selectedYear(args.year, distributions);
  const distribution = distributions.find((d) => d.year === year)!;
  const filters: Record<string, string> = { HCPCS_Cd: code };
  const state = stringArg(args.state)?.toUpperCase();
  if (state) {
    if (!/^[A-Z]{2}$/.test(state)) throw new Error('state must be a two-letter abbreviation');
    filters.Rndrng_Prvdr_State_Abrvtn = state;
  }
  const limit = intArg(args.limit, 25, 1, 100);
  const offset = intArg(args.offset, 0, 0, 10_000);
  const [providers, stats] = await Promise.all([
    cmsDataRows(distribution.url, filters, limit, offset),
    cmsDataStats(distribution.url, filters),
  ]);
  return {
    hcpcs_code: code, year, state: state ?? null,
    matching_rows: stats.found_rows, returned: providers.length,
    providers: providers.map(projectProvider), dataset: distribution,
    source: utilizationSource(),
    interpretation: 'matching_rows is the authoritative filtered row count; providers is a bounded API-order sample, not a ranking. Rows represent Medicare fee-for-service claims meeting CMS publication thresholds and exclude suppressed or non-FFS activity.',
  };
}

async function productMarketProfile(args: Record<string, unknown>) {
  const query = requiredString(args, 'query');
  const codes = stringArray(args.hcpcs_codes, 'hcpcs_codes', 1, 5).map(hcpcsArg);
  const limit = intArg(args.policy_limit, 10, 1, 25);
  const [ncdPayload, ncaPayload, ...trends] = await Promise.all([
    cms('/reports/national-coverage-ncd/'),
    cms('/reports/national-coverage-ncacal/'),
    ...codes.map((hcpcs_code) => hcpcsTrend({
      hcpcs_code, from_year: args.from_year, to_year: args.to_year,
    })),
  ]);
  const needle = query.toLowerCase();
  const ncds = rows(ncdPayload).filter((row) =>
    includesAny(row, needle, ['title', 'document_display_id', 'chapter'])).slice(0, limit).map(cleanObject);
  const analyses = rows(ncaPayload).filter((row) =>
    includesAny(row, needle, ['title', 'document_display_id', 'review_type', 'document_type']))
    .slice(0, limit).map(cleanObject);
  return {
    query,
    national_policy: { ncds, analyses },
    hcpcs_codes: trends,
    interpretation: 'Policy matches are text-search results, and HCPCS codes are caller-supplied associations—not CMS-validated product mappings. Claims reflect Medicare fee-for-service utilization, not total demand, revenue, coverage, or adoption. Verify coding, linked articles/LCDs, effective dates, and claim requirements.',
  };
}

const PART_D_SPENDING_TITLE = 'Medicare Part D Spending by Drug';
const PART_D_PRESCRIBER_TITLE = 'Medicare Part D Prescribers - by Provider and Drug';
const INPATIENT_PROVIDER_TITLE = 'Medicare Inpatient Hospitals - by Provider and Service';
const OUTPATIENT_PROVIDER_TITLE = 'Medicare Outpatient Hospitals - by Provider and Service';
const INPATIENT_GEOGRAPHY_TITLE = 'Medicare Inpatient Hospitals - by Geography and Service';
const OUTPATIENT_GEOGRAPHY_TITLE = 'Medicare Outpatient Hospitals - by Geography and Service';
const DME_PROVIDER_SERVICE_TITLE = 'Medicare Durable Medical Equipment, Devices & Supplies - by Supplier and Service';
const DME_GEOGRAPHY_SERVICE_TITLE = 'Medicare Durable Medical Equipment, Devices & Supplies - by Geography and Service';
const ENROLLMENT_TITLE = 'Medicare Monthly Enrollment';
const POST_ACUTE_TITLES = {
  'Home Health': 'Medicare Post-Acute Care Utilization - Home Health Agency by Geography and Provider',
  Hospice: 'Medicare Post-Acute Care Utilization - Hospice by Geography and Provider',
  'Skilled Nursing': 'Medicare Post-Acute Care Utilization - Skilled Nursing Facility by Geography and Provider',
} as const;

async function partDDrugSpending(args: Record<string, unknown>) {
  const drug = requiredString(args, 'drug');
  const distribution = (await catalogDistributions(PART_D_SPENDING_TITLE)).at(-1)!;
  const limit = intArg(args.limit, 25, 1, 100);
  const offset = intArg(args.offset, 0, 0, 10_000);
  const [candidates, stats] = await Promise.all([
    cmsDataRows(distribution.url, {}, 100, offset, drug),
    cmsDataStats(distribution.url, {}, drug),
  ]);
  const needle = drug.toLowerCase();
  const drugs = candidates.filter((row) =>
    [row.Brnd_Name, row.Gnrc_Name].some((value) => String(value ?? '').toLowerCase().includes(needle)))
    .slice(0, limit).map(projectPartDSpending);
  return {
    // total is CMS's authoritative keyword-match count, NOT the size of this
    // page. Reporting drugs.length here (as this did until review) told a caller
    // that a search for "insulin" matched 25 rows when CMS reports 437 — a 17x
    // understatement of coverage, from the one field an agent reads to decide
    // whether it has seen everything. Every sibling tool in this pack already
    // sources total from /stats; this was the only one that didn't.
    total: stats.found_rows, returned: drugs.length, drugs,
    dataset: distribution, source: partDSource(),
    interpretation: `${partDInterpretation()} total counts rows CMS matched on the keyword across all columns; the rows returned are additionally narrowed to those whose brand or generic name contains the term, so returned can be smaller than a single page even when total is large. Page through with offset.`,
  };
}

async function partDPrescriberExposure(args: Record<string, unknown>) {
  const brandName = requiredString(args, 'brand_name');
  const distributions = await catalogDistributions(PART_D_PRESCRIBER_TITLE);
  const year = selectedYear(args.year, distributions);
  const distribution = distributions.find((row) => row.year === year)!;
  const filters: Record<string, string> = { Brnd_Name: brandName };
  const state = optionalState(args.state);
  if (state) filters.Prscrbr_State_Abrvtn = state;
  const limit = intArg(args.limit, 25, 1, 100);
  const offset = intArg(args.offset, 0, 0, 10_000);
  const [rowsValue, stats] = await Promise.all([
    cmsDataRows(distribution.url, filters, limit, offset),
    cmsDataStats(distribution.url, filters),
  ]);
  return {
    brand_name: brandName, year, state: state ?? null,
    matching_rows: stats.found_rows, returned: rowsValue.length,
    prescribers: rowsValue.map(projectPartDPrescriber),
    dataset: distribution, source: partDSource(),
    interpretation: 'matching_rows is the authoritative filtered row count; prescribers is a bounded API-order sample, not a ranking. CMS suppresses some values and the dataset excludes prescriptions outside Medicare Part D. Drug cost is gross program spending, not manufacturer revenue or prescriber compensation.',
  };
}

async function partDGenericCompetition(args: Record<string, unknown>) {
  const genericName = requiredString(args, 'generic_name');
  const distribution = (await catalogDistributions(PART_D_SPENDING_TITLE)).at(-1)!;
  const limit = intArg(args.limit, 50, 1, 100);
  const [rowsValue, stats] = await Promise.all([
    cmsDataRows(distribution.url, { Gnrc_Name: genericName }, limit),
    cmsDataStats(distribution.url, { Gnrc_Name: genericName }),
  ]);
  const brands = rowsValue.map(projectPartDSpending);
  return {
    generic_name: genericName, matching_rows: stats.found_rows, returned: brands.length, brands,
    reported_manufacturer_count: Math.max(0, ...rowsValue.map((row) => numberValue(row.Tot_Mftr))),
    dataset: distribution, source: partDSource(),
    interpretation: 'Brand rows share the exact CMS generic-name value. reported_manufacturer_count is CMS’s aggregate field, not a disclosed company list, current launch count, availability measure, or market share. Gross Part D spending is not manufacturer revenue, net price, profit, or total US sales.',
  };
}

async function hospitalMarket(args: Record<string, unknown>, kind: 'inpatient' | 'outpatient') {
  const inpatient = kind === 'inpatient';
  const code = inpatient ? drgArg(args.drg_code) : apcArg(args.apc_code);
  const title = inpatient ? INPATIENT_PROVIDER_TITLE : OUTPATIENT_PROVIDER_TITLE;
  const codeColumn = inpatient ? 'DRG_Cd' : 'APC_Cd';
  const distributions = await catalogDistributions(title);
  const year = selectedYear(args.year, distributions);
  const distribution = distributions.find((row) => row.year === year)!;
  const filters: Record<string, string> = { [codeColumn]: code };
  const state = optionalState(args.state);
  if (state) filters.Rndrng_Prvdr_State_Abrvtn = state;
  const limit = intArg(args.limit, 25, 1, 100);
  const offset = intArg(args.offset, 0, 0, 10_000);
  const [rowsValue, stats] = await Promise.all([
    cmsDataRows(distribution.url, filters, limit, offset),
    cmsDataStats(distribution.url, filters),
  ]);
  const hospitals = rowsValue.map((row) => projectHospital(row, kind));
  return {
    total: stats.found_rows, returned: hospitals.length, hospitals,
    service_type: inpatient ? 'Inpatient DRG' : 'Outpatient APC', code, year, state: state ?? null,
    dataset: distribution, source: hospitalSource(),
    interpretation: 'total is the authoritative matching hospital-service row count; hospitals is a bounded API-order sample, not a ranking. Medicare fee-for-service claims exclude Medicare Advantage and suppressed activity. Average payment is not hospital revenue, margin, or a guaranteed future rate.',
  };
}

async function hospitalServiceTrend(args: Record<string, unknown>) {
  const type = requiredString(args, 'service_type');
  const inpatient = type === 'Inpatient DRG';
  if (!inpatient && type !== 'Outpatient APC') throw new Error('service_type must be Inpatient DRG or Outpatient APC');
  const code = inpatient ? drgArg(args.code) : apcArg(args.code);
  const title = inpatient ? INPATIENT_GEOGRAPHY_TITLE : OUTPATIENT_GEOGRAPHY_TITLE;
  const codeColumn = inpatient ? 'DRG_Cd' : 'APC_Cd';
  const distributions = await catalogDistributions(title);
  const [from, to] = utilizationYearRange(args, distributions);
  const selected = distributions.filter((row) => row.year >= from && row.year <= to);
  const years = await Promise.all(selected.map(async (distribution) => {
    const rowsValue = await cmsDataRows(distribution.url, { [codeColumn]: code }, 10);
    const national = rowsValue.filter((row) =>
      String(row.Rndrng_Prvdr_Geo_Lvl ?? '').toLowerCase() === 'national');
    return summarizeHospitalYear(distribution.year, national, distribution, kindFromBoolean(inpatient));
  }));
  return {
    service_type: type, code, years, source: hospitalSource(),
    interpretation: 'National annual aggregates cover Medicare fee-for-service claims and are subject to CMS suppression and methodology changes. They exclude Medicare Advantage and do not measure total market demand, hospital revenue, profitability, or a guaranteed payment rate.',
  };
}

function kindFromBoolean(inpatient: boolean): 'inpatient' | 'outpatient' {
  return inpatient ? 'inpatient' : 'outpatient';
}

async function dmeSupplierMarket(args: Record<string, unknown>) {
  const code = hcpcsArg(args.hcpcs_code);
  const distributions = await catalogDistributions(DME_PROVIDER_SERVICE_TITLE);
  const year = selectedYear(args.year, distributions);
  const distribution = distributions.find((row) => row.year === year)!;
  const filters: Record<string, string> = { HCPCS_Cd: code };
  const state = optionalState(args.state);
  if (state) filters.Suplr_Prvdr_State_Abrvtn = state;
  const limit = intArg(args.limit, 25, 1, 100);
  const offset = intArg(args.offset, 0, 0, 10_000);
  const [rowsValue, stats] = await Promise.all([
    cmsDataRows(distribution.url, filters, limit, offset), cmsDataStats(distribution.url, filters),
  ]);
  const suppliers = rowsValue.map(projectDmeSupplier);
  return {
    total: stats.found_rows, returned: suppliers.length, suppliers, hcpcs_code: code, year, state: state ?? null,
    dataset: distribution, source: dmeSource(),
    interpretation: 'total is the authoritative filtered row count; suppliers is a bounded API-order sample, not a ranking. CMS fee-for-service data excludes Medicare Advantage and suppressed activity. Payments are not supplier revenue, margin, or total US demand.',
  };
}

async function dmeServiceTrend(args: Record<string, unknown>) {
  const code = hcpcsArg(args.hcpcs_code);
  const distributions = await catalogDistributions(DME_GEOGRAPHY_SERVICE_TITLE);
  const [from, to] = utilizationYearRange(args, distributions);
  const years = await Promise.all(distributions.filter((row) => row.year >= from && row.year <= to).map(async (distribution) => {
    const values = await cmsDataRows(distribution.url, { HCPCS_Cd: code, Rfrg_Prvdr_Geo_Lvl: 'National' }, 10);
    const row = values.find((value) => String(value.Rfrg_Prvdr_Geo_Desc) === 'National');
    return row ? { year: distribution.year, data_available: true, ...projectDmeGeography(row), dataset: distribution }
      : { year: distribution.year, data_available: false, dataset: distribution };
  }));
  return {
    hcpcs_code: code, years, source: dmeSource(),
    interpretation: 'National annual rows are Medicare fee-for-service public-use aggregates subject to suppression and methodology changes. They exclude Medicare Advantage and do not measure total market demand, supplier revenue, margin, or unique people across other settings.',
  };
}

function postAcuteTitle(value: unknown) {
  const type = requiredString({ service_type: value }, 'service_type');
  if (!(type in POST_ACUTE_TITLES)) throw new Error('service_type must be Home Health, Hospice, or Skilled Nursing');
  return [type as keyof typeof POST_ACUTE_TITLES, POST_ACUTE_TITLES[type as keyof typeof POST_ACUTE_TITLES]] as const;
}

async function postAcuteProviderMarket(args: Record<string, unknown>) {
  const [type, title] = postAcuteTitle(args.service_type);
  const distributions = await catalogDistributions(title);
  const year = selectedYear(args.year, distributions);
  const distribution = distributions.find((row) => row.year === year)!;
  const filters: Record<string, string> = { SMRY_CTGRY: 'PROVIDER' };
  const state = optionalState(args.state);
  if (state) filters.STATE = state;
  const limit = intArg(args.limit, 25, 1, 100);
  const offset = intArg(args.offset, 0, 0, 10_000);
  const [values, stats] = await Promise.all([
    cmsDataRows(distribution.url, filters, limit, offset), cmsDataStats(distribution.url, filters),
  ]);
  const providers = values.map(projectPostAcute);
  return {
    total: stats.found_rows, returned: providers.length, providers, service_type: type, year, state: state ?? null,
    dataset: distribution, source: postAcuteSource(),
    interpretation: 'total is the authoritative filtered row count; providers is a bounded API-order sample, not a ranking. CMS fee-for-service data is suppressed in places and excludes Medicare Advantage. Medicare payments are not provider revenue, margin, quality, or capacity.',
  };
}

async function postAcuteTrend(args: Record<string, unknown>) {
  const [type, title] = postAcuteTitle(args.service_type);
  const distributions = await catalogDistributions(title);
  const [from, to] = utilizationYearRange(args, distributions);
  const years = await Promise.all(distributions.filter((row) => row.year >= from && row.year <= to).map(async (distribution) => {
    const values = await cmsDataRows(distribution.url, { SMRY_CTGRY: 'NATION' }, 5);
    const row = values.find((value) => String(value.PRVDR_ID) === 'NATIONAL TOTAL');
    return row ? { year: distribution.year, data_available: true, ...projectPostAcute(row), dataset: distribution }
      : { year: distribution.year, data_available: false, dataset: distribution };
  }));
  return {
    service_type: type, years, source: postAcuteSource(),
    interpretation: 'National annual figures are Medicare fee-for-service public-use aggregates subject to suppression and methodology changes. Home health uses calendar year while hospice and skilled nursing use fiscal year in current CMS files. Payments are not provider revenue or total US demand.',
  };
}

async function enrollmentTrend(args: Record<string, unknown>) {
  const distribution = (await catalogDistributions(ENROLLMENT_TITLE)).at(-1)!;
  const state = optionalState(args.state);
  const filters = state
    ? { BENE_GEO_LVL: 'State', BENE_STATE_ABRVTN: state, MONTH: 'Year' }
    : { BENE_GEO_LVL: 'National', BENE_STATE_ABRVTN: 'US', MONTH: 'Year' };
  const values = await cmsDataRows(distribution.url, filters, 100);
  const available = values.map((row) => numberValue(row.YEAR)).filter(Number.isInteger);
  if (!available.length) return { geography: state ?? 'US', years: [], source: enrollmentSource(), interpretation: enrollmentInterpretation() };
  const min = Math.min(...available), max = Math.max(...available);
  const from = args.from_year == null ? Math.max(min, max - 9) : Number(args.from_year);
  const to = args.to_year == null ? max : Number(args.to_year);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to || to - from > 15) {
    throw new Error('from_year and to_year must be an ascending range spanning at most 16 years');
  }
  const years = values.filter((row) => numberValue(row.YEAR) >= from && numberValue(row.YEAR) <= to)
    .sort((a, b) => numberValue(a.YEAR) - numberValue(b.YEAR)).map(projectEnrollment);
  return {
    geography: state ?? 'US', years, dataset: distribution, source: enrollmentSource(),
    interpretation: enrollmentInterpretation(),
  };
}

async function resolveState(value: string): Promise<{ id: number; description: string }> {
  return resolveStateFromRows(value, rows(await cms('/metadata/states/')));
}

function resolveStateFromRows(value: string, all: Array<Record<string, unknown>>): { id: number; description: string } {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, string> = {
    al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado',
    ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho',
    il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana',
    me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota',
    ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada',
    nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york',
    nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon',
    pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina', sd: 'south dakota',
    tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia',
    wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming', dc: 'district of columbia',
  };
  const target = aliases[normalized] ?? normalized;
  const described = (row: Record<string, unknown>) => String(row.description ?? '').toLowerCase();
  // CMS splits states that span multiple MAC jurisdictions, so there is no row
  // literally named "California" — only "California - Entire State",
  // "California - Northern" and "California - Southern" (same for New York and
  // Missouri). An exact-equality match therefore rejected three of the largest
  // Medicare states outright. Prefer the whole-state row; fall back to the
  // first jurisdiction only if CMS ever drops the "Entire State" row.
  const state = all.find((row) => described(row) === target)
    ?? all.find((row) => described(row) === `${target} - entire state`)
    ?? all.find((row) => described(row).startsWith(`${target} - `));
  if (!state) throw new Error(`Unknown CMS coverage state: ${value}`);
  return { id: Number(state.state_id), description: String(state.description ?? '') };
}

interface CmsDistribution {
  year: number;
  url: string;
  modified: string | null;
  dataset_title: string;
}
interface CatalogDistribution {
  format?: string;
  description?: string;
  accessURL?: string;
  temporal?: string;
  modified?: string;
}
interface CatalogDataset {
  title?: string;
  distribution?: CatalogDistribution[];
}

async function utilizationDistributions(kind: 'geography' | 'provider'): Promise<CmsDistribution[]> {
  return catalogDistributions(kind === 'geography'
    ? 'Medicare Physician & Other Practitioners - by Geography and Service'
    : 'Medicare Physician & Other Practitioners - by Provider and Service');
}

async function catalogDistributions(title: string): Promise<CmsDistribution[]> {
  const response = await fetch(CMS_CATALOG, { headers: { Accept: 'application/json' } });
  const payload = await boundedJson(response, 'CMS data catalog', 3_000_000) as { dataset?: CatalogDataset[] };
  const dataset = (payload.dataset ?? []).find((row) => row.title === title);
  if (!dataset) throw new Error(`CMS catalog did not contain ${title}.`);
  const byYear = new Map<number, CmsDistribution>();
  for (const distribution of dataset.distribution ?? []) {
    if (distribution.format !== 'API' || !distribution.accessURL || !distribution.temporal) continue;
    const year = Number(distribution.temporal.slice(0, 4));
    if (!Number.isInteger(year)) continue;
    const candidate = {
      year, url: distribution.accessURL, modified: distribution.modified ?? null, dataset_title: title,
    };
    const existing = byYear.get(year);
    if (!existing || distribution.description === 'latest') byYear.set(year, candidate);
  }
  const result = [...byYear.values()].sort((a, b) => a.year - b.year);
  if (!result.length) throw new Error(`CMS catalog exposed no API distributions for ${title}.`);
  return result;
}

async function cmsDataRows(urlValue: string, filters: Record<string, string>, size: number, offset = 0, keyword?: string) {
  const url = new URL(urlValue);
  url.searchParams.set('size', String(size));
  if (offset) url.searchParams.set('offset', String(offset));
  if (keyword) url.searchParams.set('keyword', keyword);
  for (const [column, value] of Object.entries(filters)) url.searchParams.set(`filter[${column}]`, value);
  const payload = await boundedJson(await fetch(url, { headers: { Accept: 'application/json' } }),
    'CMS utilization query', 4_000_000);
  if (!Array.isArray(payload)) throw new Error('CMS utilization query returned a non-array response.');
  return payload.filter((row): row is Record<string, unknown> =>
    !!row && typeof row === 'object' && !Array.isArray(row));
}

async function cmsDataStats(urlValue: string, filters: Record<string, string>, keyword?: string) {
  const url = new URL(`${urlValue.replace(/\/$/, '')}/stats`);
  if (keyword) url.searchParams.set('keyword', keyword);
  for (const [column, value] of Object.entries(filters)) url.searchParams.set(`filter[${column}]`, value);
  const payload = await boundedJson(await fetch(url, { headers: { Accept: 'application/json' } }),
    'CMS utilization statistics', 100_000) as Record<string, unknown>;
  return {
    found_rows: numberValue(payload.found_rows),
    total_rows: numberValue(payload.total_rows),
  };
}

async function boundedJson(response: Response, label: string, max: number): Promise<unknown> {
  if (!response.ok) throw new Error(`${label} failed (${response.status})`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > max) throw new Error(`${label} exceeded size limit`);
  const text = await response.text();
  if (new TextEncoder().encode(text).length > max) throw new Error(`${label} exceeded size limit`);
  return JSON.parse(text);
}

function summarizeUtilizationYear(year: number, rowsValue: Array<Record<string, unknown>>, distribution: CmsDistribution) {
  const services = rowsValue.reduce((sum, row) => sum + numberValue(row.Tot_Srvcs), 0);
  const weighted = (field: string) => services
    ? rowsValue.reduce((sum, row) => sum + numberValue(row[field]) * numberValue(row.Tot_Srvcs), 0) / services
    : null;
  return {
    year,
    hcpcs_description: rowsValue.find((row) => row.HCPCS_Desc)?.HCPCS_Desc ?? null,
    total_services: services,
    average_allowed_amount_weighted_by_services: weighted('Avg_Mdcr_Alowd_Amt'),
    average_payment_amount_weighted_by_services: weighted('Avg_Mdcr_Pymt_Amt'),
    by_place_of_service: rowsValue.map(projectGeography),
    dataset: distribution,
  };
}

const projectGeography = (row: Record<string, unknown>) => cleanObject({
  geography_level: row.Rndrng_Prvdr_Geo_Lvl,
  geography_code: row.Rndrng_Prvdr_Geo_Cd,
  geography: row.Rndrng_Prvdr_Geo_Desc,
  hcpcs_code: row.HCPCS_Cd,
  hcpcs_description: row.HCPCS_Desc,
  place_of_service: row.Place_Of_Srvc === 'F' ? 'Facility' : row.Place_Of_Srvc === 'O' ? 'Non-facility' : row.Place_Of_Srvc,
  rendering_providers: nullableNumber(row.Tot_Rndrng_Prvdrs),
  beneficiaries: nullableNumber(row.Tot_Benes),
  services: nullableNumber(row.Tot_Srvcs),
  beneficiary_day_services: nullableNumber(row.Tot_Bene_Day_Srvcs),
  average_submitted_charge: nullableNumber(row.Avg_Sbmtd_Chrg),
  average_medicare_allowed_amount: nullableNumber(row.Avg_Mdcr_Alowd_Amt),
  average_medicare_payment_amount: nullableNumber(row.Avg_Mdcr_Pymt_Amt),
  average_medicare_standardized_amount: nullableNumber(row.Avg_Mdcr_Stdzd_Amt),
});

const projectProvider = (row: Record<string, unknown>) => cleanObject({
  npi: row.Rndrng_NPI,
  provider_name: [row.Rndrng_Prvdr_First_Name, row.Rndrng_Prvdr_MI, row.Rndrng_Prvdr_Last_Org_Name]
    .filter(Boolean).join(' '),
  entity_type: row.Rndrng_Prvdr_Ent_Cd === 'I' ? 'Individual' : row.Rndrng_Prvdr_Ent_Cd === 'O' ? 'Organization' : row.Rndrng_Prvdr_Ent_Cd,
  city: row.Rndrng_Prvdr_City, state: row.Rndrng_Prvdr_State_Abrvtn, zip5: row.Rndrng_Prvdr_Zip5,
  provider_type: row.Rndrng_Prvdr_Type, medicare_participating: row.Rndrng_Prvdr_Mdcr_Prtcptg_Ind === 'Y',
  hcpcs_code: row.HCPCS_Cd, hcpcs_description: row.HCPCS_Desc,
  place_of_service: row.Place_Of_Srvc === 'F' ? 'Facility' : row.Place_Of_Srvc === 'O' ? 'Non-facility' : row.Place_Of_Srvc,
  beneficiaries: nullableNumber(row.Tot_Benes), services: nullableNumber(row.Tot_Srvcs),
  average_allowed_amount: nullableNumber(row.Avg_Mdcr_Alowd_Amt),
  average_payment_amount: nullableNumber(row.Avg_Mdcr_Pymt_Amt),
});

const projectPartDSpending = (row: Record<string, unknown>) => cleanObject({
  brand_name: row.Brnd_Name, generic_name: row.Gnrc_Name,
  manufacturer: row.Mftr_Name, total_manufacturers: nullableNumber(row.Tot_Mftr),
  years: [2020, 2021, 2022, 2023, 2024].map((year) => ({
    year,
    total_spending: nullableNumber(row[`Tot_Spndng_${year}`]),
    dosage_units: nullableNumber(row[`Tot_Dsg_Unts_${year}`]),
    claims: nullableNumber(row[`Tot_Clms_${year}`]),
    beneficiaries: nullableNumber(row[`Tot_Benes_${year}`]),
    average_spending_per_dosage_unit_weighted: nullableNumber(row[`Avg_Spnd_Per_Dsg_Unt_Wghtd_${year}`]),
    average_spending_per_claim: nullableNumber(row[`Avg_Spnd_Per_Clm_${year}`]),
    average_spending_per_beneficiary: nullableNumber(row[`Avg_Spnd_Per_Bene_${year}`]),
    outlier_flag: String(row[`Outlier_Flag_${year}`] ?? '') === '1',
  })),
  change_average_unit_spending_2023_2024: nullableNumber(row.Chg_Avg_Spnd_Per_Dsg_Unt_23_24),
  cagr_average_unit_spending_2020_2024: nullableNumber(row.CAGR_Avg_Spnd_Per_Dsg_Unt_20_24),
});

const projectPartDPrescriber = (row: Record<string, unknown>) => cleanObject({
  npi: row.Prscrbr_NPI,
  prescriber_name: [row.Prscrbr_First_Name, row.Prscrbr_Last_Org_Name].filter(Boolean).join(' '),
  city: row.Prscrbr_City, state: row.Prscrbr_State_Abrvtn, prescriber_type: row.Prscrbr_Type,
  brand_name: row.Brnd_Name, generic_name: row.Gnrc_Name,
  claims: nullableNumber(row.Tot_Clms), thirty_day_fills: nullableNumber(row.Tot_30day_Fills),
  day_supply: nullableNumber(row.Tot_Day_Suply), drug_cost: nullableNumber(row.Tot_Drug_Cst),
  beneficiaries: nullableNumber(row.Tot_Benes),
});

function projectHospital(row: Record<string, unknown>, kind: 'inpatient' | 'outpatient') {
  const common = {
    ccn: row.Rndrng_Prvdr_CCN, hospital_name: row.Rndrng_Prvdr_Org_Name,
    city: row.Rndrng_Prvdr_City, state: row.Rndrng_Prvdr_State_Abrvtn, zip5: row.Rndrng_Prvdr_Zip5,
  };
  return kind === 'inpatient' ? cleanObject({
    ...common, drg_code: row.DRG_Cd, drg_description: row.DRG_Desc,
    discharges: nullableNumber(row.Tot_Dschrgs),
    average_submitted_covered_charge: nullableNumber(row.Avg_Submtd_Cvrd_Chrg),
    average_total_payment: nullableNumber(row.Avg_Tot_Pymt_Amt),
    average_medicare_payment: nullableNumber(row.Avg_Mdcr_Pymt_Amt),
  }) : cleanObject({
    ...common, apc_code: row.APC_Cd, apc_description: row.APC_Desc,
    beneficiaries: nullableNumber(row.Bene_Cnt), comprehensive_apc_services: nullableNumber(row.CAPC_Srvcs),
    average_submitted_charges: nullableNumber(row.Avg_Tot_Sbmtd_Chrgs),
    average_medicare_allowed_amount: nullableNumber(row.Avg_Mdcr_Alowd_Amt),
    average_medicare_payment: nullableNumber(row.Avg_Mdcr_Pymt_Amt),
    outlier_services: nullableNumber(row.Outlier_Srvcs),
    average_medicare_outlier_amount: nullableNumber(row.Avg_Mdcr_Outlier_Amt),
  });
}

function summarizeHospitalYear(year: number, rowsValue: Array<Record<string, unknown>>,
  distribution: CmsDistribution, kind: 'inpatient' | 'outpatient') {
  if (!rowsValue.length) return { year, data_available: false, dataset: distribution };
  const row = rowsValue[0];
  return kind === 'inpatient' ? {
    year, data_available: true, description: row.DRG_Desc ?? null,
    discharges: nullableNumber(row.Tot_Dschrgs),
    average_submitted_covered_charge: nullableNumber(row.Avg_Submtd_Cvrd_Chrg),
    average_total_payment: nullableNumber(row.Avg_Tot_Pymt_Amt),
    average_medicare_payment: nullableNumber(row.Avg_Mdcr_Pymt_Amt),
    dataset: distribution,
  } : {
    year, data_available: true, description: row.APC_Desc ?? null,
    beneficiaries: nullableNumber(row.Bene_Cnt),
    comprehensive_apc_services: nullableNumber(row.CAPC_Srvcs),
    average_submitted_charges: nullableNumber(row.Avg_Tot_Sbmtd_Chrgs),
    average_medicare_allowed_amount: nullableNumber(row.Avg_Mdcr_Alowd_Amt),
    average_medicare_payment: nullableNumber(row.Avg_Mdcr_Pymt_Amt),
    dataset: distribution,
  };
}

const projectDmeSupplier = (row: Record<string, unknown>) => ({
  npi: row.Suplr_NPI,
  supplier_name: [row.Suplr_Prvdr_First_Name, row.Suplr_Prvdr_Last_Name_Org].filter(Boolean).join(' '),
  entity_type: row.Suplr_Prvdr_Ent_Cd === 'I' ? 'Individual' : row.Suplr_Prvdr_Ent_Cd === 'O' ? 'Organization' : row.Suplr_Prvdr_Ent_Cd,
  city: row.Suplr_Prvdr_City, state: row.Suplr_Prvdr_State_Abrvtn, zip5: row.Suplr_Prvdr_Zip5,
  specialty: row.Suplr_Prvdr_Spclty_Desc, hcpcs_code: row.HCPCS_Cd, hcpcs_description: row.HCPCS_Desc,
  rental: row.Suplr_Rentl_Ind === 'Y', beneficiaries: nullableNumber(row.Tot_Suplr_Benes),
  claims: nullableNumber(row.Tot_Suplr_Clms), services: nullableNumber(row.Tot_Suplr_Srvcs),
  average_submitted_charge: nullableNumber(row.Avg_Suplr_Sbmtd_Chrg),
  average_medicare_allowed_amount: nullableNumber(row.Avg_Suplr_Mdcr_Alowd_Amt),
  average_medicare_payment: nullableNumber(row.Avg_Suplr_Mdcr_Pymt_Amt),
});

const projectDmeGeography = (row: Record<string, unknown>) => cleanObject({
  hcpcs_description: row.HCPCS_Desc, rbcs_category: row.RBCS_Desc, rental: row.Suplr_Rentl_Ind === 'Y',
  referring_providers: nullableNumber(row.Tot_Rfrg_Prvdrs), suppliers: nullableNumber(row.Tot_Suplrs),
  beneficiaries: nullableNumber(row.Tot_Suplr_Benes), claims: nullableNumber(row.Tot_Suplr_Clms),
  services: nullableNumber(row.Tot_Suplr_Srvcs), average_submitted_charge: nullableNumber(row.Avg_Suplr_Sbmtd_Chrg),
  average_medicare_allowed_amount: nullableNumber(row.Avg_Suplr_Mdcr_Alowd_Amt),
  average_medicare_payment: nullableNumber(row.Avg_Suplr_Mdcr_Pymt_Amt),
});

const projectPostAcute = (row: Record<string, unknown>) => ({
  provider_id: row.PRVDR_ID, provider_name: row.PRVDR_NAME, city: row.PRVDR_CITY, state: row.STATE, zip: row.PRVDR_ZIP,
  year_basis: row.YEAR_TYPE, beneficiaries: nullableNumber(row.BENE_DSTNCT_CNT),
  episodes_or_stays: nullableNumber(row.TOT_EPSD_STAY_CNT), service_days: nullableNumber(row.TOT_SRVC_DAYS),
  total_charges: nullableNumber(row.TOT_CHRG_AMT), total_allowed_amount: nullableNumber(row.TOT_ALOWD_AMT),
  total_medicare_payment: nullableNumber(row.TOT_MDCR_PYMT_AMT),
  total_standardized_payment: nullableNumber(row.TOT_MDCR_STDZD_PYMT_AMT),
  average_beneficiary_age: nullableNumber(row.BENE_AVG_AGE), average_risk_score: nullableNumber(row.BENE_AVG_RISK_SCRE),
});

const projectEnrollment = (row: Record<string, unknown>) => cleanObject({
  year: numberValue(row.YEAR), total_beneficiaries: nullableNumber(row.TOT_BENES),
  original_medicare_beneficiaries: nullableNumber(row.ORGNL_MDCR_BENES),
  medicare_advantage_and_other_beneficiaries: nullableNumber(row.MA_AND_OTH_BENES),
  medicare_advantage_share: ratio(row.MA_AND_OTH_BENES, row.TOT_BENES),
  part_d_total_beneficiaries: nullableNumber(row.PRSCRPTN_DRUG_TOT_BENES),
  part_d_pdp_beneficiaries: nullableNumber(row.PRSCRPTN_DRUG_PDP_BENES),
  part_d_mapd_beneficiaries: nullableNumber(row.PRSCRPTN_DRUG_MAPD_BENES),
  dual_eligible_beneficiaries: nullableNumber(row.DUAL_TOT_BENES),
});

function ratio(numerator: unknown, denominator: unknown) {
  const n = nullableNumber(numerator), d = nullableNumber(denominator);
  return n === null || d === null || d === 0 ? null : n / d;
}

function selectedYear(value: unknown, distributions: CmsDistribution[]) {
  const latest = distributions.at(-1)!.year;
  const year = value == null ? latest : Number(value);
  if (!Number.isInteger(year) || !distributions.some((row) => row.year === year)) {
    throw new Error(`year must be one of ${distributions.map((row) => row.year).join(', ')}`);
  }
  return year;
}
function utilizationYearRange(args: Record<string, unknown>, distributions: CmsDistribution[]): [number, number] {
  const latest = distributions.at(-1)!.year;
  const earliest = distributions[0].year;
  const from = args.from_year == null ? Math.max(earliest, latest - 4) : Number(args.from_year);
  const to = args.to_year == null ? latest : Number(args.to_year);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) throw new Error('from_year and to_year must be an ascending integer range');
  if (to - from > 7) throw new Error('utilization trend may span at most 8 years');
  if (!distributions.some((row) => row.year === from) || !distributions.some((row) => row.year === to)) {
    throw new Error(`year range must be within ${earliest}-${latest}`);
  }
  return [from, to];
}
function utilizationSource() { return 'CMS Medicare Physician & Other Practitioners public use files via data.cms.gov'; }
function utilizationInterpretation() {
  return 'These are Medicare fee-for-service public-use aggregates with CMS suppression and methodology limits. They exclude Medicare Advantage and other non-FFS use, do not establish coverage, and must not be interpreted as total market demand, company revenue, or unique-patient counts across settings.';
}

async function cms(path: string, params: Record<string, unknown> = {}, token?: string): Promise<Record<string, unknown>> {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== '') {
    url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (response.status === 401 || response.status === 403) {
    throw new Error('CMS Coverage rejected the license token. Obtain a fresh token directly from the CMS license-agreement endpoint after accepting its terms.');
  }
  if (!response.ok) throw await httpError(response, 'CMS Coverage API request failed');
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new Error('CMS Coverage response exceeded size limit');
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('CMS Coverage response exceeded size limit');
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const status = (parsed.meta as { status?: { id?: number; message?: string } } | undefined)?.status;
  if (status?.id && status.id >= 400) throw new Error(`CMS Coverage API: ${status.message ?? status.id}`);
  return parsed;
}

function rows(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(payload.data) ? payload.data.filter((row): row is Record<string, unknown> =>
    !!row && typeof row === 'object' && !Array.isArray(row)) : [];
}
function listResult(key: string, values: Array<Record<string, unknown>>, total: number, interpretation: string) {
  return { total, returned: values.length, [key]: values.map(cleanObject), source: source(), interpretation };
}
function cleanObject(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) =>
    value !== null && value !== undefined && value !== ''));
}
// Match every whitespace-separated term somewhere in the searchable fields,
// rather than the raw query string against each field on its own. CMS titles
// are long and formal ("Beta Amyloid Positron Tomography in Dementia and
// Neurodegenerative Disease"), so a natural two-word query only ever matched
// when the caller happened to reproduce CMS's exact word order.
function includesAny(row: Record<string, unknown>, query: string, fields: string[]) {
  const haystack = fields.map((field) => String(row[field] ?? '')).join(' ').toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  return terms.every((term) => haystack.includes(term));
}
function cleanHtml(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&sol;/g, '/')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20_000);
}
function source() { return 'CMS Medicare Coverage Database Coverage API v1.6'; }
function nationalInterpretation() {
  return 'An NCD is national Medicare policy, but actual payment still depends on beneficiary eligibility, benefit category, coding, documentation, setting, and effective dates. This is not medical or billing advice.';
}
function localInterpretation() {
  return 'An LCD is issued by a Medicare Administrative Contractor for specified jurisdictions. It is not national policy or a guarantee of payment; verify contractor, location, version, coding article, documentation, and service date.';
}
function analysisInterpretation() {
  return 'NCAs and related updates describe CMS policy-development activity. An open or proposed analysis is not a final coverage decision and should not be presented as one.';
}
function idArg(value: unknown): string {
  const id = stringArg(value); if (!id || !/^\d+$/.test(id)) throw new Error('document_id must contain digits only'); return id;
}
function prefixedId(value: string, prefix: string): string {
  const normalized = value.toUpperCase().startsWith(prefix) ? value.slice(prefix.length) : value;
  if (!/^\d+$/.test(normalized)) throw new Error(`${prefix} identifier must contain digits only`);
  return `${prefix}${normalized}`;
}
function hcpcsArg(value: unknown): string {
  const code = stringArg(value)?.toUpperCase();
  if (!code || !/^[A-Z0-9]{5}$/.test(code)) throw new Error('hcpcs_code must contain exactly five letters/digits');
  return code;
}
function drgArg(value: unknown): string {
  const code = stringArg(value);
  if (!code || !/^\d{1,3}$/.test(code)) throw new Error('drg_code must contain 1-3 digits');
  return code.padStart(3, '0');
}
function apcArg(value: unknown): string {
  const code = stringArg(value);
  if (!code || !/^\d{4}$/.test(code)) throw new Error('apc_code must contain exactly four digits');
  return code;
}
function optionalState(value: unknown): string | null {
  const state = stringArg(value)?.toUpperCase() ?? null;
  if (state && !/^[A-Z]{2}$/.test(state)) throw new Error('state must be a two-letter abbreviation');
  return state;
}
function stringArray(value: unknown, key: string, min: number, max: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  const result = value.map(stringArg).filter((item): item is string => Boolean(item));
  if (result.length < min || result.length > max || result.length !== value.length) {
    throw new Error(`${key} must contain ${min}-${max} non-empty strings`);
  }
  return result;
}
function numberValue(value: unknown): number {
  const number = Number(value); return Number.isFinite(number) ? number : 0;
}
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value); return Number.isFinite(number) ? number : null;
}
function requiredString(args: Record<string, unknown>, key: string) { const value = stringArg(args[key]); if (!value) throw new Error(`${key} is required`); return value; }
function stringArg(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function optionalPositiveInt(value: unknown): number | null { if (value == null) return null; const n = Number(value); if (!Number.isInteger(n) || n < 1) throw new Error('version must be a positive integer'); return n; }
function limitArg(args: Record<string, unknown>) { return intArg(args.limit, 25, 1, 100); }
function intArg(value: unknown, fallback: number, min: number, max: number) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback; }
function compact<T extends Record<string, unknown>>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== '')) as T; }
function partDSource() { return 'CMS Medicare Part D public use files via data.cms.gov'; }
function partDInterpretation() {
  return 'CMS Medicare Part D public-use data is subject to suppression and methodology limits. Gross drug cost/spending is not manufacturer revenue, net price, profit, rebates, prescriptions outside Part D, or total US sales.';
}
function hospitalSource() { return 'CMS Medicare Inpatient/Outpatient Hospitals public use files via data.cms.gov'; }
function dmeSource() { return 'CMS Medicare DME, Devices & Supplies public use files via data.cms.gov'; }
function postAcuteSource() { return 'CMS Medicare Post-Acute Care Utilization public use files via data.cms.gov'; }
function enrollmentSource() { return 'CMS Medicare Monthly Enrollment public use file via data.cms.gov'; }
function enrollmentInterpretation() {
  return 'Counts describe Medicare program enrollment, not utilization, product demand, health outcomes, or company revenue. Medicare Advantage and other is CMS’s combined category; MA-PD and PDP are Part D enrollment types and should not be added to total beneficiaries.';
}

export default { tools, callTool, meter: { credits: 3 } } satisfies McpToolExport;
