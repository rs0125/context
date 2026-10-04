const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const GMAIL_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz';
const MAILBOX = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * Best-effort Gmail web UI link, not a documented Google API contract.
 * Use only fresh, authorized provider metadata; the stored draft ID remains the
 * authority for reads and updates. Unknown formats fall back to the Drafts folder
 * at the caller. In particular, messageId must not substitute for threadId.
 *
 * Encoding reference: InboxSDK's gmail-driver/encodeDraftUrlId.ts and
 * gmail-sync-response-processor.test.ts (decimal thread-f ID / legacy hex ID).
 * https://github.com/InboxSDK/InboxSDK/tree/main/src/platform-implementation-js/dom-driver/gmail
 */
export function gmailDraftLink(
  mailbox: string,
  draft: { id: string; threadId: string | null },
): string | undefined {
  // Link formatting must never turn a successful provider mutation into a failure.
  try {
    if (typeof mailbox !== 'string' || mailbox.length > 254 || !MAILBOX.test(mailbox)) return undefined;
    if (!draft || typeof draft.id !== 'string' || !/^r-?[1-9]\d{0,18}$/.test(draft.id)) return undefined;
    if (typeof draft.threadId !== 'string' || !/^[a-f\d]{1,16}$/i.test(draft.threadId)) return undefined;
    const draftNumber = BigInt(draft.id.slice(1));
    if (draftNumber < -(1n << 63n) || draftNumber >= (1n << 63n)) return undefined;
    const threadNumber = BigInt(`0x${draft.threadId}`);
    if (threadNumber === 0n) return undefined;

    const raw = `f:${threadNumber}+msg-a:${draft.id}`;
    const base64 = Buffer.from(raw, 'utf8').toString('base64').replace(/=+$/, '');
    let value = 0n;
    for (const character of base64) {
      value = value * 64n + BigInt(BASE64_ALPHABET.indexOf(character));
    }
    let compose = '';
    const radix = BigInt(GMAIL_ALPHABET.length);
    do {
      compose = GMAIL_ALPHABET[Number(value % radix)] + compose;
      value /= radix;
    } while (value > 0n);
    if (compose.length > 512) return undefined;

    const url = new URL('https://mail.google.com/mail/');
    url.searchParams.set('authuser', mailbox);
    url.hash = `drafts?compose=${compose}`;
    return url.href.length <= 2048 ? url.href : undefined;
  } catch {
    return undefined;
  }
}
