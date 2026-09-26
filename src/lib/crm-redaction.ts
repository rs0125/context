export type CrmTextState = 'missing' | 'present' | 'redacted' | 'unsupported' | 'truncated';
export type RedactedCrmText = {
  state: CrmTextState;
  text: string | null;
  redacted: boolean;
  truncated: boolean;
};
export type CrmTextOptions = { maxCharacters?: number; format?: 'plain' | 'blocknote' };

const MAX_INPUT = 100_000;
const MAX_OUTPUT = 12_000;
const EMPTY: RedactedCrmText = { state: 'missing', text: null, redacted: false, truncated: false };
const UNSUPPORTED: RedactedCrmText = { state: 'unsupported', text: null, redacted: false, truncated: false };

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    commat: '@', period: '.', colon: ':', plus: '+', lpar: '(', rpar: ')',
    sol: '/', bsol: '\\', hyphen: '-', tab: '\t', newline: '\n',
  };
  // Decode before redaction, including doubly encoded numeric contacts. Bound
  // passes so deliberately recursive entities cannot consume unbounded work.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
      if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? whole;
      const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isInteger(number) && number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number) : ' ';
    });
    if (next === text) break;
    text = next;
  }
  return text;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** BlockNote's stored JSON array is a sequence of blocks with text/link inline
 * content and optional children. Never stringify unknown objects or properties.
 */
function blocknoteText(value: unknown): { text: string; omitted: boolean } | null {
  let blocks = value;
  if (typeof blocks === 'string') {
    if (blocks.length > MAX_INPUT) return null;
    try { blocks = JSON.parse(blocks); } catch { return null; }
  }
  if (!Array.isArray(blocks)) return null;
  const text: string[] = [];
  let visited = 0;
  let characters = 0;
  let omitted = false;
  const inline = (nodes: unknown): string | null => {
    if (!Array.isArray(nodes) || nodes.length > 1000) return null;
    let output = '';
    for (const node of nodes) {
      if (++visited > 2000 || !record(node)) return null;
      if (node.type === 'text' && typeof node.text === 'string') output += node.text;
      else if (node.type === 'link' && Array.isArray(node.content)) {
        omitted = true;
        // Only link label text is retained. Nested links and hidden attributes
        // are deliberately unsupported rather than treated as visible text.
        for (const child of node.content) {
          if (++visited > 2000 || !record(child) || child.type !== 'text' || typeof child.text !== 'string') return null;
          output += child.text;
        }
      } else return null;
      if (output.length > MAX_INPUT) return null;
    }
    return output;
  };
  const visit = (nodes: unknown[], depth: number): boolean => {
    if (depth > 8 || nodes.length > 1000) return false;
    for (const block of nodes) {
      if (++visited > 2000 || !record(block) || typeof block.type !== 'string'
        || !['paragraph', 'heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'quote', 'codeBlock'].includes(block.type)) return false;
      const content = block.content === undefined ? '' : inline(block.content);
      if (content === null) return false;
      characters += content.length;
      if (characters > MAX_INPUT) return false;
      text.push(content);
      if (block.children !== undefined && (!Array.isArray(block.children) || !visit(block.children, depth + 1))) return false;
    }
    return true;
  };
  return visit(blocks, 0) ? { text: text.join('\n'), omitted } : null;
}

/** A bounded plain-text view, never a general-purpose guarantee against every
 * possible contact encoding. Redact before truncation so a cut cannot expose a
 * prefix of a detected phone/email. No original source value is returned.
 */
export function redactCrmText(value: unknown, options: CrmTextOptions = {}): RedactedCrmText {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return { ...EMPTY };
  const maxCharacters = Math.min(MAX_OUTPUT, Math.max(1, Math.floor(options.maxCharacters ?? 4000)));
  if (!Number.isFinite(maxCharacters)) return { ...UNSUPPORTED };
  const converted = options.format === 'blocknote' ? blocknoteText(value) : null;
  const input = options.format === 'blocknote' ? converted?.text ?? null : typeof value === 'string' ? value : null;
  if (input === null || input.length > MAX_INPUT) return { ...UNSUPPORTED };
  if (!input.trim()) return { ...EMPTY };
  let text = decodeEntities(input).normalize('NFKC')
    .replace(/[\p{Cf}\u034f\uFE00-\uFE0F\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '');
  let redacted = converted?.omitted ?? false;
  const mask = (pattern: RegExp, replacement: string | ((...args: string[]) => string)) => {
    text = text.replace(pattern, (...args: string[]) => {
      redacted = true;
      return typeof replacement === 'string' ? replacement : replacement(...args);
    });
  };
  // Remove active/invisible HTML content before stripping formatting tags.
  const invisibleTag = /<(script|style|iframe|object|svg|template)\b[^<>]*>/gi;
  let start = 0;
  let html = '';
  let tag: RegExpExecArray | null;
  while ((tag = invisibleTag.exec(text))) {
    redacted = true;
    html += text.slice(start, tag.index) + '[content omitted]';
    const closing = new RegExp(`</${tag[1]}\\s*>`, 'gi');
    closing.lastIndex = invisibleTag.lastIndex;
    const end = closing.exec(text);
    start = end ? closing.lastIndex : text.length;
    invisibleTag.lastIndex = start;
  }
  text = html + text.slice(start);
  // Delimiter-excluding/length-bounded tokens avoid quadratic backtracking on
  // malformed markup, huge fake emails or repeated unclosed bracket strings.
  start = 0;
  html = '';
  let comment = text.indexOf('<!--');
  while (comment !== -1) {
    redacted = true;
    html += text.slice(start, comment);
    const end = text.indexOf('-->', comment + 4);
    start = end === -1 ? text.length : end + 3;
    comment = text.indexOf('<!--', start);
  }
  text = html + text.slice(start);
  mask(/<[^<>]{0,2000}>/g, ' ');
  mask(/!\[[^\[\]\n]{0,2000}\]\([^()\n]{0,4000}\)/g, '[media omitted]');
  mask(/\[([^\[\]\n]{0,2000})\]\([^()\n]{0,4000}\)/g, (_whole, label) => label);
  mask(/(?:https?:\/\/|ftp:\/\/|www\.|(?:wa\.me|api\.whatsapp\.com|t\.me)\/)[^\s<>]+/gi, '[link omitted]');
  mask(/(?:mailto:|tel:|sms:|whatsapp:)[^\s<>]+/gi, '[contact omitted]');
  mask(/(?<![\p{L}\p{N}._%+\-])[\p{L}\p{N}._%+\-]{1,64}\s{0,8}@\s{0,8}[\p{L}\p{N}.\-]{1,253}\.[\p{L}]{2,63}/gu, '[email omitted]');
  mask(/\b(?:[a-z][a-z0-9+.-]{0,24}:\/\/|(?:javascript|data|file):)[^\s<>]+/gi, '[link omitted]');
  mask(/(?<![\p{L}\p{N}])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.){1,10}[\p{L}]{2,63}(?:[/?#][^\s<>]*)?/gu, '[link omitted]');
  // Plain business dates and explicitly labelled sqft ranges can otherwise
  // resemble a separated phone. Protect only complete, validated expressions;
  // unknown/unlabelled numeric strings still pass through the phone masker.
  let prefix = 'CRMSAFEVALUE';
  while (text.includes(prefix)) prefix += 'X';
  const protectedValues: string[] = [];
  const protect = (value: string) => `${prefix}${protectedValues.push(value) - 1}END`;
  text = text.replace(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g, value => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? protect(value) : value;
  });
  const quantityNumber = '(?:[0-9]{1,3}(?:,[0-9]{2}){0,4},[0-9]{3}|[0-9]{1,3}(?:,[0-9]{3}){1,3}|[0-9]{1,10})';
  const areaQuantity = new RegExp(`(?<![\\p{L}\\p{N}])(${quantityNumber})(?:\\s*[-–—]\\s*(${quantityNumber}))?\\s*(?:sqft|sft|sq\\.?\\s*ft\\.?|square\\s*(?:feet|foot))(?![\\p{L}\\p{N}])`, 'giu');
  text = text.replace(areaQuantity, (whole: string, first: string, second?: string) => {
    const from = Number(first.replaceAll(',', ''));
    const to = second === undefined ? from : Number(second.replaceAll(',', ''));
    return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from > 0 && to >= from && to <= 1_000_000_000
      ? protect(whole) : whole;
  });
  mask(/(?<!\p{Nd})(?:\+[\s(]*)?\(?\p{Nd}(?:[\s().,\-–—/\\]*\p{Nd}){6,}\)?(?!\p{Nd})/gu, '[phone omitted]');
  // Spoken digits are common in copied chat notes. Do not preserve an obvious
  // alternative representation after masking the numeric version.
  mask(/\b(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)[\s,.-]+){6,}(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)\b/gi, '[phone omitted]');
  // Leftover entity syntax can conceal contact characters that were not among
  // the supported decodings. Withhold that token rather than echoing it.
  mask(/&(?:amp;)*(?:#[a-z0-9]+|[a-z]+);/gi, '[entity omitted]');
  text = text.replace(new RegExp(`${prefix}([0-9]+)END`, 'g'), (_whole, index: string) => protectedValues[Number(index)]);
  text = text.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = text.length > maxCharacters;
  if (truncated) text = text.slice(0, maxCharacters).trimEnd();
  return { state: truncated ? 'truncated' : redacted ? 'redacted' : text ? 'present' : 'missing', text: text || null, redacted, truncated };
}
