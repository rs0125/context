import { afterEach, describe, expect, it, vi } from 'vitest';
import { anonymousRequestLimit, createAnonymousLimiter } from '../src/lib/rate-limit';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('bounded anonymous failure tracking', () => {
  it('limits each failed credential independently and resets at the exact window boundary', () => {
    const limiter = createAnonymousLimiter(8, 1000);
    for (let attempt = 0; attempt < 5; attempt++) { limiter.check('access', 'bad', 5, 100); limiter.record('access', 'bad', 100); }
    expect(() => limiter.check('access', 'bad', 5, 1099)).toThrowError(expect.objectContaining({ status: 429 }));
    expect(() => limiter.check('access', 'valid', 5, 1099)).not.toThrow();
    expect(() => limiter.check('refresh', 'bad', 5, 1099)).not.toThrow();
    expect(() => limiter.check('access', 'bad', 5, 1100)).not.toThrow();
  });
  it('keeps memory bounded under rotating attacker-controlled inputs', () => {
    const limiter = createAnonymousLimiter(8);
    for (let index = 0; index < 10_000; index++) limiter.record('access', `synthetic-bad-${index}`, 100);
    expect(limiter.size()).toBe(8);
    for (let index = 0; index < 200; index++) limiter.record('access', 'repeated-bad', 100);
    expect(limiter.size()).toBe(8);
    expect(() => limiter.check('access', 'repeated-bad', 5, 100)).toThrow();
  });
  it('never consumes failure budget just by checking a potentially valid credential', () => {
    const limiter = createAnonymousLimiter();
    for (let index = 0; index < 500; index++) limiter.check('access', 'valid', 5, 100);
    expect(limiter.size()).toBe(0);
  });
  it('uses Vercel client addresses only for anonymous registration controls', () => {
    vi.stubEnv('VERCEL', '1');
    const first = new Request('https://example.test/oauth/register', { headers: { 'x-vercel-forwarded-for': '203.0.113.11' } });
    const other = new Request('https://example.test/oauth/register', { headers: { 'x-vercel-forwarded-for': '203.0.113.12' } });
    for (let i = 0; i < 10; i++) anonymousRequestLimit(first, 'synthetic-register', 10);
    expect(() => anonymousRequestLimit(first, 'synthetic-register', 10)).toThrowError(expect.objectContaining({ status: 429 }));
    expect(() => anonymousRequestLimit(other, 'synthetic-register', 10)).not.toThrow();
  });
  it('does not trust arbitrary forwarded headers outside Vercel', () => {
    vi.stubEnv('VERCEL', '');
    for (let i = 0; i < 10; i++) anonymousRequestLimit(new Request('http://localhost/oauth/register', { headers: { 'x-vercel-forwarded-for': `203.0.113.${i}` } }), 'synthetic-local', 10);
    expect(() => anonymousRequestLimit(new Request('http://localhost/oauth/register', { headers: { 'x-forwarded-for': '198.51.100.22' } }), 'synthetic-local', 10)).toThrowError(expect.objectContaining({ status: 429 }));
  });
});
