interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/** Medicare national and local coverage policy from the official CMS Coverage API. */

const BASE = 'https://api.coverage.cms.gov/v1';
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

async function resolveState(value: string): Promise<{ id: number; description: string }> {
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
  const all = rows(await cms('/metadata/states/'));
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
  if (!response.ok) throw new Error(`CMS Coverage API request failed (${response.status})`);
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
function requiredString(args: Record<string, unknown>, key: string) { const value = stringArg(args[key]); if (!value) throw new Error(`${key} is required`); return value; }
function stringArg(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function optionalPositiveInt(value: unknown): number | null { if (value == null) return null; const n = Number(value); if (!Number.isInteger(n) || n < 1) throw new Error('version must be a positive integer'); return n; }
function limitArg(args: Record<string, unknown>) { return intArg(args.limit, 25, 1, 100); }
function intArg(value: unknown, fallback: number, min: number, max: number) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback; }
function compact<T extends Record<string, unknown>>(value: T): T { return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== '')) as T; }

export default { tools, callTool, meter: { credits: 3 } } satisfies McpToolExport;
