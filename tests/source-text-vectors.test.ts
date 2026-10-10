/** Shared with baileys-ramesh containsUserText. Keep the fixture byte-identical in both repos. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hasSourceExcerpt } from '../src/lib/crm-writes/rfq';

type Vector = { name: string; source: string; excerpt: string; expected: boolean };
const { vectors } = JSON.parse(readFileSync(new URL('./fixtures/source-text-vectors.json', import.meta.url), 'utf8')) as { vectors: Vector[] };

describe('shared source-text matching vectors', () => {
  it('loads the shared vectors', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });
  it.each(vectors.map(vector => [vector.name, vector] as const))('%s', (_name, { source, excerpt, expected }) => {
    expect(hasSourceExcerpt(source, excerpt)).toBe(expected);
  });
});
