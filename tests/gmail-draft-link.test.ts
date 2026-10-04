import { describe, expect, it } from 'vitest';
import { gmailDraftLink } from '../src/lib/gmail-draft-link';

const mailbox = 'employee+assistant@example.com';
const draft = { id: 'r-4437691956637862407', threadId: '1773a3deb8f31481' };

// Independent decoder only for synthetic/public fixture assertions.
function decodeCompose(url: URL) {
  const alphabet = 'BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz';
  const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const token = new URLSearchParams(url.hash.slice('#drafts?'.length)).get('compose')!;
  let value = [...token].reduce((acc, character) => acc * BigInt(alphabet.length) + BigInt(alphabet.indexOf(character)), 0n);
  let encoded = '';
  do {
    encoded = base64[Number(value % 64n)] + encoded;
    value /= 64n;
  } while (value > 0n);
  return Buffer.from(encoded, 'base64').toString('utf8');
}

describe('best-effort Gmail draft links', () => {
  it('matches the public InboxSDK compose encoding fixture exactly', () => {
    // These IDs/token are from InboxSDK encodeDraftUrlId.test.ts, not a mailbox.
    const publicThreadId = BigInt('1689835521506698369').toString(16);
    const result = new URL(gmailDraftLink(mailbox, { ...draft, threadId: publicThreadId })!);
    expect(result.hash).toBe('#drafts?compose=CqMvqmRLbRhtqczNhFhkDQPRFTQBHmDpFpKtPVWGdZHFgscZcWpMKGJpSjgpgpvdSbRMRTSpSxB');
    expect(result.origin).toBe('https://mail.google.com');
    expect(result.pathname).toBe('/mail/');
    expect([...result.searchParams]).toEqual([['authuser', mailbox]]);
    expect(result.searchParams.has('compose')).toBe(false);
  });

  it.each(['r1234567890123456789', 'r-1234567890123456789', 'r9223372036854775807', 'r-9223372036854775808'])(
    'preserves signed draft IDs and full 64-bit thread precision: %s', id => {
      const result = new URL(gmailDraftLink(mailbox, { id, threadId: 'FFFFFFFFFFFFFFFE' })!);
      expect(decodeCompose(result)).toBe(`f:18446744073709551614+msg-a:${id}`);
      expect(result.search).toContain('employee%2Bassistant%40example.com');
    },
  );

  it('links by the fresh thread ID independently of the current message ID', () => {
    const record = { ...draft, threadId: '1234abcd', messageId: 'fffedcba' };
    const result = new URL(gmailDraftLink(mailbox, record)!);
    expect(decodeCompose(result)).toBe(`f:305441741+msg-a:${draft.id}`);
  });

  it.each([
    '', ' employee@example.com', 'employee@example.com ', 'Name <employee@example.com>',
    'employee@example.com\r\nX-Header: injected', 'employee@example.com#drafts?compose=new',
    'employee@example.com&authuser=attacker', 'https://evil.example/mail', 'employee@-example.com',
    'employee@example-.com', 'employee@localhost', 'employee..@', 'x'.repeat(65) + '@example.com',
    'employee@' + 'x'.repeat(64) + '.com', 'employee@' + Array(4).fill('x'.repeat(63)).join('.'),
  ])('falls back for an unsupported or malicious mailbox: %j', value => {
    expect(gmailDraftLink(value, draft)).toBeUndefined();
  });

  it.each([
    '', 'draft123', 'r0', 'r-0', 'r01', 'r+123', 'r--123', 'r123/send', 'r123?compose=new',
    'r123\n', 'r9223372036854775808', 'r-9223372036854775809', `r${'1'.repeat(200)}`,
  ])('falls back for an unsupported draft ID: %j', id => {
    expect(gmailDraftLink(mailbox, { ...draft, id })).toBeUndefined();
  });

  it.each([null, '', '0', '0000', 'thread-f:123', 'g1234', '123/send', '1?compose=new', '1\n', 'a'.repeat(17)])(
    'falls back for a missing or unsupported thread ID: %j', threadId => {
      expect(gmailDraftLink(mailbox, { ...draft, threadId })).toBeUndefined();
    },
  );

  it('does not throw on malformed provider metadata after a successful write', () => {
    expect(gmailDraftLink(mailbox, null as unknown as typeof draft)).toBeUndefined();
    expect(gmailDraftLink(undefined as unknown as string, draft)).toBeUndefined();
    expect(gmailDraftLink(mailbox, { id: 42, threadId: {} } as unknown as typeof draft)).toBeUndefined();
  });
});
