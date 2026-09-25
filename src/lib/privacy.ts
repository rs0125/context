/** Allowlisted labels are still untrusted database strings. Fail closed on contact
 * markers; this is defence in depth, not a redactor for arbitrary notes/media.
 */
export function sanitizeLabel(value: unknown, maxLength = 100): string | null {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
  if (!text || text.length > maxLength || /[\x00-\x1f<>@]/.test(text)) return null;
  if ([...text].some(character => /\p{Nd}/u.test(character) && !/[0-9]/.test(character))) return null;
  if (/(?:https?:|www\.|mailto:|tel:|wa\.me|whatsapp|contact\s*(?:me|us|number)|call\s*(?:me|us|on))/i.test(text)) return null;
  if (/(?:\d[\s\p{P}\p{S}]*){7,}/u.test(text)) return null;
  if (/(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)[\s,.-]+){6,}(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)/i.test(text)) return null;
  return text;
}

export function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !/^\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?\s*$/.test(value)) return null;
  const number = Number(value.replaceAll(',', '').trim());
  return Number.isFinite(number) && number >= 0 ? number : null;
}
