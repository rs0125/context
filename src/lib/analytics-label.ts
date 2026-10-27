import { redactCrmText } from './crm-redaction';
import { analyticsCalendar } from './analytics-query';

function decode(value: string): string {
  for (let i = 0; i < 3; i++) {
    try { const decoded = decodeURIComponent(value); if (decoded === value) break; value = decoded; } catch { break; }
  }
  return value.normalize('NFKC').replace(/[\p{Cf}\x00-\x1f\x7f]/gu, '');
}
/** Only dimensions selected by static presets enter this function. It is not a
 * claim to identify every personal name or deliberately obfuscated contact. */
export function safeAnalyticsLabel(value: string, name = ''): { value: string | null; redacted: boolean } {
  const text = decode(value);
  if (name === 'date') {
    const normalized = /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}` : text;
    try { analyticsCalendar(normalized); return { value: normalized, redacted: false }; } catch { return { value: null, redacted: true }; }
  }
  if (name === 'page' || name === 'landingPage' || name === 'pagePath') {
    if (['(not set)', '(other)'].includes(text)) return { value: text, redacted: false };
    try {
      const url = new URL(text, 'https://wareongo.com');
      if (!['http:', 'https:'].includes(url.protocol)) return { value: '[URL omitted]', redacted: true };
      const decodedPath = decode(url.pathname);
      const cleanPath = decodedPath.split(/[?#]/, 1)[0];
      const path = redactCrmText(cleanPath, { maxCharacters: 512 });
      const host = redactCrmText(url.hostname.replaceAll('.', ' '), { maxCharacters: 253 });
      if (host.redacted || path.state === 'unsupported') return { value: '[URL omitted]', redacted: true };
      const pathValue = (path.text ?? '/').replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[identifier omitted]');
      return { value: name === 'page' ? `${url.protocol}//${url.hostname}${pathValue}` : pathValue,
        redacted: !!(url.search || url.hash || url.username || url.password || path.redacted || path.truncated || pathValue !== path.text || text !== value || cleanPath !== decodedPath) };
    } catch { return { value: '[URL omitted]', redacted: true }; }
  }
  // Keep ordinary referral domains useful while applying the same text masker
  // to the rest of the label. A domain is never returned with URL credentials.
  let domain: string | null = null;
  let input = text;
  if (name === 'sessionSourceMedium') {
    const match = /^((?:[a-z0-9-]+\.)+[a-z]{2,63})(\s*\/\s*[a-z_]+)$/i.exec(text);
    if (match && !redactCrmText(match[1].replaceAll('.', ' ')).redacted) { domain = match[1]; input = `ANALYTICSSAFEDOMAIN${match[2]}`; }
  }
  const result = redactCrmText(input, { maxCharacters: 256 });
  let output = result.text?.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[identifier omitted]') ?? null;
  if (domain && output) output = output.replace('ANALYTICSSAFEDOMAIN', domain);
  return { value: output, redacted: result.redacted || result.truncated || text !== value || (!!output && !domain && output !== result.text) };
}
