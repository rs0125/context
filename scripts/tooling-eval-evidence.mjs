/** Deterministic evidence checks for synthetic evaluations, not a production
 * redactor or a claim that arbitrary prose has been semantically verified. */
export const measurementSchema = {
  type: 'object', additionalProperties: false,
  properties: { field: { type: 'string' }, kind: { type: 'string', enum: ['exact', 'approximate', 'range', 'unknown'] },
    value: { type: ['number', 'null'] }, lower: { type: ['number', 'null'] }, upper: { type: ['number', 'null'] } },
  required: ['field', 'kind', 'value', 'lower', 'upper'],
};

export function measurementClaims(record) {
  return Object.entries(record.field_evidence ?? {}).map(([field, evidence]) => ({ field, kind: evidence.kind,
    value: evidence.value ?? null, lower: evidence.lower ?? null, upper: evidence.upper ?? null }));
}

function strings(value, path = []) {
  if (typeof value === 'string') return [{ text: value, path }];
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, [...path, index]));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => [{ text: key, path: [] }, ...strings(item, [...path, key])]);
  return [];
}
const normalize = text => text.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
const dates = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?\b/g;
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthRange = new RegExp(`\\b(${months.join('|')})\\s+(\\d{1,2})(?:\\s*[-–—]\\s*(\\d{1,2}))?,?\\s+(\\d{4})\\b`, 'gi');
function withoutCalendarRanges(text, calendar) {
  return text.replace(monthRange, (raw, month, from, to, year) => {
    const day = value => `${year}-${String(months.indexOf(month.toLowerCase()) + 1).padStart(2, '0')}-${String(value).padStart(2, '0')}`;
    return calendar.has(day(from)) && calendar.has(day(to ?? from)) ? ' calendar range ' : raw;
  });
}
function withoutCalendarProse(text, source) {
  const tokens = strings(source).flatMap(({ text }) => [...text.matchAll(dates)].map(match => match[0]));
  const calendar = new Set(tokens.map(value => value.slice(0, 10)));
  text = withoutCalendarRanges(text, calendar);
  // Recognize a small set of ordinary date/time presentations; never add date
  // components to the general numeric whitelist ("five docks" is not a date).
  text = text.replace(new RegExp(`\\b(?:(\\d{1,2})\\s+)?(${months.join('|')})(?:\\s+(\\d{4}))?\\b`, 'gi'), (raw, day, month, year) =>
    [...calendar].some(value => value.slice(5, 7) === String(months.indexOf(month.toLowerCase()) + 1).padStart(2, '0') && (!year || value.startsWith(year)) && (!day || Number(value.slice(8)) === Number(day))) ? ' calendar ' : raw);
  return text.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(UTC|IST)\b/gi, (raw, hour, minute, zone) =>
    tokens.some(value => value.includes('T') && new Date(Date.parse(value) + (zone.toUpperCase() === 'IST' ? 330 * 60_000 : 0)).toISOString().slice(11, 16) === `${hour.padStart(2, '0')}:${minute}`) ? ' source time ' : raw);
}
export const verificationCaveat = /\b(?:need(?:s|ed)?|require(?:s|d)?|must|pending|awaiting)\b.{0,65}\b(?:verif\w*|confirm\w*)\b|\b(?:verification|confirmation)\s+(?:(?:is|are)\s+)?(?:required|needed|pending|necessary)\b|\b(?:verify|unverified)\b|(?:^|[.!?;]\s*)\s*(?:please\s+)?(?:check|confirm)\b/i;
const spokenDigitSequence = /(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)[\s,.-]+){6,}(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)/i;
const delimitedUuid = /(?<![\p{L}\p{N}_])[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}(?![\p{L}\p{N}_])/giu;
function referenceField(path) {
  return (path.length === 3 && path[0] === 'items' && Number.isInteger(path[1]) && path[2] === 'id')
    || (path.length === 2 && path[0] === 'evidence_paths' && Number.isInteger(path[1]));
}

/** Inspect every string, including object keys. Exempt exact source references
 * only in ID/citation fields, plus delimited grounded UUIDs in prose. Numeric
 * IDs are never removed from prose: repeated IDs can form a phone number. */
export function containsContact(value, references = new Set(), calendar = new Set()) {
  return strings(value).some(({ text: raw, path }) => {
    if (referenceField(path) && references.has(raw)) return false;
    let text = normalize(raw).replace(delimitedUuid, token => references.has(token) ? ' reference ' : token);
    text = withoutCalendarRanges(text.replace(dates, ''), calendar);
    return /@|mailto:|tel:|wa\.me|whatsapp|https?:\/\//i.test(text)
      || /(?:\p{Nd}[\s\p{P}\p{S}]*){7,}/u.test(text) || spokenDigitSequence.test(text);
  });
}

// A small lexical check rejects unsupported numeric claims without trying to
// parse English grammar. Structured measurement equality is the primary check.
const numberWords = Object.fromEntries(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'].map((word, value) => [word, value]));
function numbers(text) {
  const normalized = normalize(text).replace(dates, '').replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/gi, word => String(numberWords[word.toLowerCase()]));
  return [...normalized.matchAll(/\d+(?:,\d{2,3})*(?:\.\d+)?/g)].map(match => Number(match[0].replaceAll(',', '')));
}
function sourceNumbers(value) {
  if (typeof value === 'number') return [value];
  if (typeof value === 'string') return numbers(value);
  if (Array.isArray(value)) return value.flatMap(sourceNumbers);
  if (value && typeof value === 'object') return Object.values(value).flatMap(sourceNumbers);
  return [];
}

const queryIdentity = entry => JSON.stringify([entry.name, Object.entries(entry.args ?? {}).filter(([key]) => !['cursor', 'limit', 'response_format'].includes(key)).sort()]);
/** A terminal page alone is not a complete result set. Follow only observed,
 * ordered cursor links for the same query, rejecting cycles and duplicate IDs. */
export function completedResultSets(successful) {
  const sets = [];
  for (let start = 0; start < successful.length; start++) {
    const first = successful[start];
    if (!['search_crm_leads', 'search_warehouses'].includes(first.name) || first.args?.cursor) continue;
    const identity = queryIdentity(first), ids = new Set(), cursors = new Set(), entries = [];
    let index = start;
    while (index < successful.length) {
      const entry = successful[index], data = entry.result?.data;
      if (!Array.isArray(data?.items)) break;
      let duplicate = false;
      for (const item of data.items) {
        if (item.id === undefined || ids.has(String(item.id))) { duplicate = true; break; }
        ids.add(String(item.id));
      }
      if (duplicate) break;
      entries.push(entry);
      if (data.nextCursor === null && data.query_context?.has_more !== true) {
        sets.push({ name: first.name, ids: [...ids], count: ids.size, entries });
        break;
      }
      const next = data.nextCursor;
      if (typeof next !== 'string' || !next || cursors.has(next)) break;
      cursors.add(next);
      index = successful.findIndex((candidate, position) => position > index && queryIdentity(candidate) === identity && candidate.args?.cursor === next);
      if (index < 0) break;
    }
  }
  return sets;
}

function withoutGroundedResultCounts(text, answer, successful) {
  const ids = new Set(answer.items.map(item => item.id));
  const complete = completedResultSets(successful).filter(set => set.count === answer.items.length && set.ids.every(id => ids.has(id)));
  // This narrow noun check permits a derived record count, not an unrelated
  // measurement that happens to equal the result-set size.
  return text.replace(/\b(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\s+(leads?|warehouses?|records?|listings?)\b(\s+(?:needs?|requires?)\s+verification)?/gi, (phrase, raw, noun, flagged) => {
    const count = numberWords[raw.toLowerCase()] ?? Number(raw);
    return complete.some(set => (flagged ? set.entries.flatMap(entry => entry.result.data.items).filter(item => item.verification_required === true).length : set.count) === count
      && (noun.toLowerCase().startsWith('record') || (noun.toLowerCase().startsWith('lead') ? set.name === 'search_crm_leads' : set.name === 'search_warehouses'))) ? 'grounded record count' : phrase;
  });
}

export function checkAnswerEvidence(answer, successful, observed = successful) {
  const failures = [];
  const records = successful.flatMap(entry => [...(entry.result.data?.items ?? []), ...(entry.result.data?.priorities ?? []), ...(entry.result.data?.id ? [entry.result.data] : [])]);
  const references = new Set([...records.map(record => String(record.id)), ...observed.filter(entry => entry.result?.source_path).map(entry => entry.result.source_path)]);
  const calendar = new Set(successful.flatMap(entry => strings(entry.result.data).flatMap(({ text }) => [...text.matchAll(dates)].map(match => match[0].slice(0, 10)))));
  if (containsContact(answer, references, calendar)) failures.push('CONTACT_IN_ANSWER');
  const observedNumbers = new Set(successful.flatMap(entry => sourceNumbers(entry.result.data)));
  // Counts stated in prose must also come from evidence, not self-reported totals.
  if (numbers(withoutCalendarProse(withoutGroundedResultCounts(answer.summary, answer, successful), successful.map(entry => entry.result.data))).some(value => !observedNumbers.has(value))) failures.push('UNSUPPORTED_SUMMARY_NUMBER');
  if (answer.total !== null && !successful.some(entry => entry.result.data?.total === answer.total)
    && !completedResultSets(successful).some(set => set.count === answer.total)) failures.push('UNGROUNDED_TOTAL');
  const groups = successful.flatMap(entry => entry.result.data?.groups ?? []);
  if (answer.groups.some(group => !groups.some(source => group.value === source.value && group.count === source.count))) failures.push('UNGROUNDED_GROUP');
  for (const item of answer.items) {
    const candidates = records.filter(record => String(record.id) === item.id);
    const warehouse = candidates.find(record => record.field_evidence);
    if (!warehouse) {
      if (item.measurements.length || item.verification_required !== null) failures.push('UNSUPPORTED_MEASUREMENT_CLAIM');
    } else {
      const expected = measurementClaims(warehouse), found = item.measurements;
      const match = found.length === expected.length && new Set(found.map(claim => claim.field)).size === found.length
        && expected.every(claim => found.some(value => Object.keys(claim).every(key => value[key] === claim[key])));
      if (!match) failures.push('MEASUREMENT_EVIDENCE_MISMATCH');
      if (item.verification_required !== warehouse.verification_required) failures.push('VERIFICATION_FLAG_MISMATCH');
    }
    const allowed = new Set(candidates.flatMap(sourceNumbers));
    // A verification instruction may restate the requested numeric bounds; it
    // must not turn those bounds into measured values (checked structurally).
    if (warehouse?.verification_required && verificationCaveat.test(item.summary)) {
      for (const entry of successful.filter(entry => entry.result.data?.items?.some(record => String(record.id) === item.id))) {
        for (const [field, value] of Object.entries(entry.args ?? {})) if (/_(?:min|max)(?:_|$)/.test(field) && typeof value === 'number') allowed.add(value);
      }
    }
    const prose = item.summary.replace(/\bpriority\s*:?\s*([1-5])\s*(?:\/|out of)\s*5\b/gi,
      (phrase, rating) => candidates.some(record => record.priority_stars === Number(rating)) ? ' grounded priority ' : phrase);
    if (numbers(withoutCalendarProse(prose, candidates)).some(value => !allowed.has(value))) failures.push('UNSUPPORTED_ITEM_NUMBER');
  }
  return [...new Set(failures)];
}

export const EVIDENCE_LIMITATION = 'Automated checks validate selected tools, structured evidence, numeric provenance and common contact markers. They do not prove all free-form prose is correct; independent human semantic review is still required. This is synthetic OpenAI tool-selection evidence, not production Claude task validation.';
