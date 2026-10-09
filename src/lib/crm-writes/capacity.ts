/** Quantity validation for explicit edits to existing RFQs; never a prerequisite for capturing a new brief. */
import { CRM_NUMBER_PATTERN, CRM_MAGNITUDE_PATTERN, CRM_MAGNITUDE_MULTIPLIERS, CRM_SQFT_PATTERN } from '../crm-fields';

const layout = (value: string) => value.replace(/\s+/gu, ' ').trim();
const capacityUnits = [CRM_SQFT_PATTERN, 'sq\\.?\\s*m\\.?|sqm|m²|square\\s*met(?:er|re)s?',
  'acres?', 'pallets?', '(?:metric\\s*)?ton(?:ne)?s?|mt', 'cbm|m³|cubic\\s*met(?:er|re)s?', 'containers?'];
export const capacityUnit = `(?:${capacityUnits.join('|')})`;
const unitFamilies = capacityUnits.map(pattern => new RegExp(`^(?:${pattern})$`, 'i'));
const capacity = new RegExp(`^(?:(?:~|≈|approx(?:imately)?\\.?|around|about|circa|at least|at most|up to|over|above|under|below|[<>]=?)\\s*)?(${CRM_NUMBER_PATTERN})\\s*(${CRM_MAGNITUDE_PATTERN})?(?:\\s*(${capacityUnit})?\\s*(?:-|–|—|to)\\s*(${CRM_NUMBER_PATTERN})\\s*(${CRM_MAGNITUDE_PATTERN})?)?\\s*(${capacityUnit})$`, 'i');
const singleCapacity = new RegExp(`^${CRM_NUMBER_PATTERN}\\s*(?:${CRM_MAGNITUDE_PATTERN})?\\s*${capacityUnit}$`, 'i');
const suffixQualifier = '(?:min(?:imum)?\\.?|max(?:imum)?\\.?|approx(?:imately)?\\.?|at least|at most|or more|or less)';

export function capacityValid(value: string) {
  if (value.length > 120) return false;
  // Normalize only explicit syntax for validation. Preserve the original value
  // in the title/description, and never turn a bound into an exact CRM integer.
  let expression = layout(value);
  const suffix = new RegExp(`\\s+(${suffixQualifier})$`, 'i').exec(expression);
  if (suffix) {
    const amount = expression.slice(0, suffix.index);
    if (!singleCapacity.test(amount)) return false;
    const bound = suffix[1].toLowerCase();
    expression = `${bound === 'or more' ? 'at least' : bound === 'or less' ? 'at most' : bound} ${amount}`;
  }
  if (expression.includes('+')) {
    if ((expression.match(/\+/g) ?? []).length !== 1) return false;
    // Plus must follow the whole quantity or the final unit, never split digits.
    const beforeUnit = new RegExp(`\\+\\s*${capacityUnit}$`, 'i');
    if (!beforeUnit.test(expression) && !/\+$/.test(expression)) return false;
    const amount = expression.replace(/\s*\+\s*/, ' ').trim();
    if (!singleCapacity.test(amount)) return false;
    expression = `at least ${amount}`;
  }
  if (/^between\s+/i.test(expression)) {
    expression = expression.replace(/^between\s+/i, '');
    if ((expression.match(/\s+and\s+/gi) ?? []).length !== 1) return false;
    expression = expression.replace(/\s+and\s+/i, ' to ');
    if (!new RegExp(`^${CRM_NUMBER_PATTERN}`).test(expression)) return false;
  } else {
    expression = expression.replace(/^(?:min(?:imum)?\.?|no less than|not less than)\s+/i, 'at least ')
      .replace(/^(?:max(?:imum)?\.?|no more than|not more than)\s+/i, 'at most ')
      .replace(/^upto\s+/i, 'up to ')
      .replace(/^more than\s+/i, 'over ').replace(/^less than\s+/i, 'under ');
  }
  const match = capacity.exec(expression);
  if (!match) return false;
  if (match[4] && /^(?:at least|at most|up to|over|above|under|below|[<>]=?)\s*/i.test(expression)) return false;
  const quantity = (raw: string, magnitude?: string) => {
    const [whole, fraction = ''] = raw.replaceAll(',', '').split('.');
    return { numerator: BigInt(whole + fraction) * BigInt(magnitude ? CRM_MAGNITUDE_MULTIPLIERS[magnitude.toLowerCase()] : 1),
      denominator: 10n ** BigInt(fraction.length) };
  };
  // Repeated units must agree. An explicit left unit also prevents borrowing
  // the right magnitude: "5 sqft - 10k sqft" starts at five, not five thousand.
  if (match[3] && !unitFamilies.some(unit => unit.test(match[3]) && unit.test(match[6]))) return false;
  const first = quantity(match[1], match[2] ?? (match[3] ? undefined : match[5]));
  const second = match[4] ? quantity(match[4], match[5]) : first;
  return first.numerator > 0n && second.numerator * first.denominator >= first.numerator * second.denominator
    && second.numerator <= 1_000_000_000n * second.denominator;
}
