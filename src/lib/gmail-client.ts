/** Narrow Gmail adapter: this module cannot send or delete mail; updates replace an existing draft only.
 * Employee/mailbox ownership and durable operation deduplication belong to the
 * calling service. Google grants compose/send together; our boundary is code.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
const DRAFTS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts';
const RESPONSE_LIMIT = 1024 * 1024;
const BODY_LIMIT = 100_000;
const REQUEST_TIMEOUT = 15_000;
const MAX_RECONCILE_MATCHES = 10;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const OPERATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HEADER_CONTROL = /[\x00-\x1f\x7f\u2028\u2029]/u;
const EMAIL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const mailbox = z.string().max(254).regex(EMAIL).refine(value => {
  const local = value.split('@')[0];
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
});
const createSchema = z.object({
  from: mailbox,
  to: z.array(mailbox).max(10).default([]),
  cc: z.array(mailbox).max(10).default([]),
  subject: z.string().trim().min(1).max(200).refine(value => !HEADER_CONTROL.test(value)),
  body: z.string().min(1).max(12_000).refine(value => !value.includes('\0')),
  operationId: z.string().regex(OPERATION_ID),
}).strict();

export type GmailCreateDraftInput = z.input<typeof createSchema>;
export type GmailUpdateDraftInput = GmailCreateDraftInput & { updateOperationId: string };
export type GmailDraft = {
  id: string;
  messageId: string;
  threadId: string | null;
  operationId: string | null;
  internetMessageId: string | null;
  updateOperationId?: string | null;
  from?: string | null;
  /** True only when full replacement cannot discard unsupported content. */
  editable?: boolean;
  subject: string | null;
  /** Mailbox entries from the saved headers; may include user-edited display names. */
  to: string[];
  cc: string[];
  bcc: string[];
  body: string | null;
  bodyTruncated: boolean;
  bodyFormat: 'text' | 'unsupported';
};
export type GmailDraftLookup = {
  draft: GmailDraft | null;
  /** Whether this bounded query was exhausted; NEVER permission to retry create.
   * Gmail search may lag, and a draft may have been moved, deleted, or sent. */
  complete: boolean;
  checked: number;
};
export type GmailClientErrorCode = 'GMAIL_INVALID_INPUT' | 'GMAIL_AUTH_REQUIRED' | 'GMAIL_ACCESS_DENIED'
  | 'GMAIL_NOT_FOUND' | 'GMAIL_RATE_LIMITED' | 'GMAIL_TIMEOUT' | 'GMAIL_ABORTED'
  | 'GMAIL_UNAVAILABLE' | 'GMAIL_RESPONSE_INVALID' | 'GMAIL_RESPONSE_TOO_LARGE';
const ERROR_MESSAGES: Record<GmailClientErrorCode, string> = {
  GMAIL_INVALID_INPUT: 'The draft request is invalid. Check recipient addresses and bounded plain-text content.',
  GMAIL_AUTH_REQUIRED: 'Reconnect the employee Gmail account before continuing.',
  GMAIL_ACCESS_DENIED: 'Gmail denied access. Check the connected account and granted compose permission.',
  GMAIL_NOT_FOUND: 'The saved Gmail draft is no longer available.',
  GMAIL_RATE_LIMITED: 'Gmail is rate limiting requests. Check the operation status before retrying.',
  GMAIL_TIMEOUT: 'The Gmail operation timed out. Check its status before trying another operation.',
  GMAIL_ABORTED: 'The Gmail operation was cancelled. Its status may need checking.',
  GMAIL_UNAVAILABLE: 'Gmail is unavailable. Check the operation status before retrying.',
  GMAIL_RESPONSE_INVALID: 'Gmail returned an unexpected response. Check the operation status.',
  GMAIL_RESPONSE_TOO_LARGE: 'The Gmail response exceeded the supported size. Check the draft in Gmail.',
};
export class GmailClientError extends Error {
  readonly code: GmailClientErrorCode;
  readonly status?: number;
  readonly operationMayHaveSucceeded: boolean;
  readonly retryAfterMs?: number;
  constructor(code: GmailClientErrorCode, options: { status?: number; operationMayHaveSucceeded?: boolean; retryAfterMs?: number } = {}) {
    super(ERROR_MESSAGES[code]);
    this.name = 'GmailClientError';
    this.code = code;
    this.status = options.status;
    this.operationMayHaveSucceeded = options.operationMayHaveSucceeded ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}
function retryDelay(value: string | null): number {
  const parsed = value && /^\d{1,10}$/.test(value) ? Number(value) * 1000
    : value && value.length <= 128 ? Date.parse(value) - Date.now() : NaN;
  return Number.isFinite(parsed) ? Math.max(1000, Math.min(86_400_000, parsed)) : 1000;
}
function invalid(): never { throw new GmailClientError('GMAIL_INVALID_INPUT'); }
function responseInvalid(): never { throw new GmailClientError('GMAIL_RESPONSE_INVALID'); }
export function operationMessageId(operationId: string): string {
  return `<wareongo.${createHash('sha256').update(operationId).digest('hex')}@drafts.wareongo.com>`;
}
function encodedSubject(subject: string): string {
  const chunks: string[] = [];
  let chunk = '';
  for (const character of subject) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 42) { chunks.push(chunk); chunk = ''; }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map(value => `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`).join('\r\n ');
}
function mime(input: z.output<typeof createSchema>, updateOperationId?: string): string {
  const body = Buffer.from(input.body.replace(/\r\n|\r|\n/g, '\r\n'), 'utf8').toString('base64');
  const headers = [
    `From: ${input.from}`, ...(input.to.length ? [`To: ${input.to.join(',\r\n ')}`] : []),
    ...(input.cc?.length ? [`Cc: ${input.cc.join(',\r\n ')}`] : []),
    `Subject: ${encodedSubject(input.subject)}`,
    `Message-ID: ${operationMessageId(input.operationId)}`,
    `X-Wareongo-Operation-ID: ${input.operationId}`,
    ...(updateOperationId ? [`X-Wareongo-Update-ID: ${updateOperationId}`] : []),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
  ];
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body.match(/.{1,76}/g)?.join('\r\n') ?? ''}\r\n`, 'utf8').toString('base64url');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) responseInvalid();
  return value as Record<string, unknown>;
}
function providerId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) responseInvalid();
  return value;
}
type Header = { name: string; value: string };
function headersOf(value: unknown): Header[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) responseInvalid();
  return value.map(item => {
    const header = object(item);
    if (typeof header.name !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(header.name)
      || typeof header.value !== 'string' || header.value.length > 16_384) responseInvalid();
    const unfolded = header.value.replace(/\r?\n[ \t]+/g, ' ');
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(unfolded)) responseInvalid();
    return { name: header.name.toLowerCase(), value: unfolded };
  });
}
function oneHeader(headers: Header[], name: string): string | null {
  const matches = headers.filter(header => header.name === name);
  if (matches.length > 1) responseInvalid();
  return matches[0]?.value.trim() ?? null;
}
function addresses(value: string | null): string[] {
  if (!value) return [];
  const entries: string[] = [];
  let start = 0, quoted = false, escaped = false, angle = 0, comment = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\' && (quoted || comment > 0)) { escaped = true; continue; }
    if (character === '"' && comment === 0) quoted = !quoted;
    if (quoted) continue;
    if (character === '(') comment++;
    if (character === ')') comment--;
    if (comment < 0 || comment > 8) responseInvalid();
    if (comment) continue;
    if (character === '<') angle++;
    if (character === '>') angle--;
    if (angle < 0 || angle > 1) responseInvalid();
    if (character === ',' && angle === 0) { entries.push(value.slice(start, index).trim()); start = index + 1; }
  }
  if (quoted || escaped || angle || comment) responseInvalid();
  entries.push(value.slice(start).trim());
  if (entries.length > 50 || entries.some(entry => !entry || entry.length > 1024)) responseInvalid();
  return entries;
}
function decodeSubject(subject: string | null): string | null {
  if (subject === null) return null;
  return subject.replace(/(\?=)[ \t]+(?==\?)/g, '$1').replace(/=\?(utf-8|us-ascii)\?([bq])\?([^?]*)\?=/gi,
    (match, _charset: string, encoding: string, content: string) => {
      try {
        const bytes = encoding.toLowerCase() === 'b' ? Buffer.from(content, 'base64')
          : Buffer.from(content.replace(/_/g, ' ').replace(/=([a-f\d]{2})/gi, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'binary');
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch { return match; }
    }).slice(0, 2000);
}
function plainBody(payload: Record<string, unknown>): Pick<GmailDraft, 'body' | 'bodyTruncated' | 'bodyFormat'> {
  const queue: { part: Record<string, unknown>; depth: number }[] = [{ part: payload, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const { part, depth } = queue.shift()!;
    if (++visited > 100 || depth > 8) responseInvalid();
    if (part.filename !== undefined && typeof part.filename !== 'string') responseInvalid();
    // Never return text attachments as the message body.
    if (part.filename) continue;
    const headers = headersOf(part.headers);
    if (/^attachment\b/i.test(oneHeader(headers, 'content-disposition') ?? '')) continue;
    if (part.mimeType === 'text/plain') {
      const contentType = oneHeader(headers, 'content-type') ?? '';
      const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1];
      if (charset && !/^(?:utf-8|us-ascii)$/i.test(charset)) continue;
      const body = part.body === undefined ? {} : object(part.body);
      if (body.attachmentId !== undefined) continue;
      if (body.data === undefined) {
        if (body.size === 0) return { body: '', bodyTruncated: false, bodyFormat: 'text' };
        continue;
      }
      if (typeof body.data !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(body.data) || body.data.length % 4 === 1) responseInvalid();
      const bytes = Buffer.from(body.data, 'base64url');
      let decoded: string;
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { responseInvalid(); }
      const truncated = bytes.length > BODY_LIMIT;
      if (truncated) decoded = new TextDecoder().decode(bytes.subarray(0, BODY_LIMIT)).replace(/\uFFFD$/, '');
      return { body: decoded, bodyTruncated: truncated, bodyFormat: 'text' };
    }
    if (part.parts !== undefined) {
      if (!Array.isArray(part.parts) || part.parts.length > 100 || queue.length + part.parts.length + visited > 100) responseInvalid();
      for (const child of part.parts) queue.push({ part: object(child), depth: depth + 1 });
    }
  }
  return { body: null, bodyTruncated: false, bodyFormat: 'unsupported' };
}
function parseDraft(value: unknown, expectedId?: string): GmailDraft {
  const draft = object(value);
  const id = providerId(draft.id);
  if (expectedId && expectedId !== id) responseInvalid();
  const message = object(draft.message);
  const payload = message.payload === undefined ? null : object(message.payload);
  const headers = headersOf(payload?.headers);
  const operationId = oneHeader(headers, 'x-wareongo-operation-id');
  if (operationId !== null && !OPERATION_ID.test(operationId)) responseInvalid();
  const updateOperationId = oneHeader(headers, 'x-wareongo-update-id');
  if (updateOperationId !== null && !OPERATION_ID.test(updateOperationId)) responseInvalid();
  const content = payload ? plainBody(payload) : { body: null, bodyTruncated: false, bodyFormat: 'unsupported' as const };
  const from = oneHeader(headers, 'from');
  const to = addresses(oneHeader(headers, 'to')), cc = addresses(oneHeader(headers, 'cc')), bcc = addresses(oneHeader(headers, 'bcc'));
  const subject = decodeSubject(oneHeader(headers, 'subject'));
  const bodyRecord = payload?.body && typeof payload.body === 'object' ? object(payload.body) : null;
  // A multipart alternative, attachment, Bcc, display-name address, or reply
  // threading metadata cannot be faithfully represented by this write schema.
  const editable = !!payload && payload.mimeType === 'text/plain' && !payload.filename
    && (payload.parts === undefined || Array.isArray(payload.parts) && payload.parts.length === 0)
    && !oneHeader(headers, 'content-disposition')
    && headers.every(header => ['from', 'to', 'cc', 'bcc', 'subject', 'message-id', 'date', 'mime-version',
      'content-type', 'content-transfer-encoding', 'x-wareongo-operation-id', 'x-wareongo-update-id',
      // Provider delivery/authentication metadata is not editable draft content.
      'received', 'x-received', 'return-path', 'delivered-to', 'authentication-results', 'dkim-signature',
      'arc-seal', 'arc-message-signature', 'arc-authentication-results'].includes(header.name)
      || /^x-(?:google-|gm-)/.test(header.name))
    && /^text\/plain(?:\s*;\s*charset=[\"']?(?:utf-8|us-ascii)[\"']?)?\s*$/i.test(oneHeader(headers, 'content-type') ?? 'text/plain')
    && content.bodyFormat === 'text' && !content.bodyTruncated && content.body !== null
    && bodyRecord !== null && typeof bodyRecord.size === 'number' && bodyRecord.size === Buffer.byteLength(content.body)
    && Buffer.byteLength(content.body) <= 20_000 && subject !== null && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(subject)
    && bcc.length === 0 && createSchema.safeParse({ from, to, cc, subject, body: content.body, operationId }).success;
  return {
    updateOperationId, from, editable,
    id, messageId: providerId(message.id), threadId: message.threadId === undefined ? null : providerId(message.threadId),
    operationId, internetMessageId: oneHeader(headers, 'message-id'), subject, to, cc, bcc, ...content,
  };
}

export type GmailClientOptions = { fetch?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number };
type Request = { kind: 'update'; id: string; raw: string } | { kind: 'create'; raw: string } | { kind: 'get'; id: string } | { kind: 'find'; operationId: string };

export class GmailClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  constructor(options: GmailClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT;
    this.#maxResponseBytes = options.maxResponseBytes ?? RESPONSE_LIMIT;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > REQUEST_TIMEOUT
      || !Number.isInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1 || this.#maxResponseBytes > RESPONSE_LIMIT) invalid();
  }
  async createDraft(accessToken: string, input: GmailCreateDraftInput, signal?: AbortSignal): Promise<GmailDraft> {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) invalid();
    const value = await this.#request(accessToken, { kind: 'create', raw: mime(parsed.data) }, signal);
    try {
      // Creation normally returns IDs only. Do not represent submitted content
      // as a verified read of Gmail's saved content; getDraft performs that read.
      return parseDraft(value);
    } catch { throw new GmailClientError('GMAIL_RESPONSE_INVALID', { operationMayHaveSucceeded: true }); }
  }
  async updateDraft(accessToken: string, draftId: string, input: GmailUpdateDraftInput, signal?: AbortSignal): Promise<GmailDraft> {
    const { updateOperationId, ...content } = input;
    const parsed = createSchema.safeParse(content);
    if (!parsed.success || !ID.test(draftId) || !OPERATION_ID.test(updateOperationId)) invalid();
    const value = await this.#request(accessToken, { kind: 'update', id: draftId, raw: mime(parsed.data, updateOperationId) }, signal);
    try { return parseDraft(value, draftId); }
    catch { throw new GmailClientError('GMAIL_RESPONSE_INVALID', { operationMayHaveSucceeded: true }); }
  }
  async getDraft(accessToken: string, draftId: string, signal?: AbortSignal): Promise<GmailDraft> {
    if (typeof draftId !== 'string' || !ID.test(draftId)) invalid();
    return parseDraft(await this.#request(accessToken, { kind: 'get', id: draftId }, signal), draftId);
  }
  async findDraftByOperation(accessToken: string, operationId: string, signal?: AbortSignal): Promise<GmailDraftLookup> {
    if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) invalid();
    // One budget for list plus every candidate read, not eleven separate budgets.
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.#timeoutMs)]);
    const listing = object(await this.#request(accessToken, { kind: 'find', operationId }, signal));
    const drafts = listing.drafts ?? [];
    if (!Array.isArray(drafts) || drafts.length > MAX_RECONCILE_MATCHES) responseInvalid();
    if (listing.nextPageToken !== undefined && (typeof listing.nextPageToken !== 'string' || listing.nextPageToken.length > 2048)) responseInvalid();
    let checked = 0, complete = !listing.nextPageToken;
    for (const item of drafts) {
      const id = providerId(object(item).id);
      try {
        const draft = await this.getDraft(accessToken, id, signal);
        checked++;
        if (draft.operationId === operationId && draft.internetMessageId === operationMessageId(operationId)) {
          return { draft, complete, checked };
        }
      } catch (error) {
        if (!(error instanceof GmailClientError) || error.code !== 'GMAIL_NOT_FOUND') throw error;
        checked++;
        complete = false;
      }
    }
    return { draft: null, complete, checked };
  }
  async #request(accessToken: string, request: Request, signal?: AbortSignal): Promise<unknown> {
    if (typeof accessToken !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(accessToken)) invalid();
    if (signal?.aborted) throw new GmailClientError('GMAIL_ABORTED');
    const url = new URL(DRAFTS_URL);
    if (request.kind === 'get') { url.pathname += `/${request.id}`; url.searchParams.set('format', 'full'); }
    if (request.kind === 'update') url.pathname += `/${request.id}`;
    if (request.kind === 'find') {
      url.searchParams.set('q', `rfc822msgid:${operationMessageId(request.operationId)}`);
      url.searchParams.set('maxResults', String(MAX_RECONCILE_MATCHES));
    }
    const creating = request.kind === 'create' || request.kind === 'update';
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(new GmailClientError(timedOut ? 'GMAIL_TIMEOUT' : 'GMAIL_ABORTED', { operationMayHaveSucceeded: creating }));
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      response = await Promise.race([this.#fetch(url.toString(), {
        method: request.kind === 'update' ? 'PUT' : creating ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(creating ? { 'Content-Type': 'application/json' } : {}) },
        ...(creating ? { body: JSON.stringify({ message: { raw: request.raw } }) } : {}),
      }), aborted]);
      if (!response.ok) {
        // Google also uses 403 for temporary quota limits. Inspect only bounded,
        // allowlisted reason codes; never surface its echoed request/message.
        let quota403 = false;
        if (response.status === 403 && response.body && /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
          reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0, complete = false;
          while (size <= 16_384) {
            const next = await Promise.race([reader.read(), aborted]);
            if (next.done) { complete = true; break; }
            size += next.value.byteLength;
            if (size <= 16_384) chunks.push(next.value);
          }
          if (complete) {
            try {
              const errors: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))?.error?.errors;
              quota403 = Array.isArray(errors) && errors.length > 0 && errors.length <= 20
                && errors.every(item => item && typeof item === 'object'
                  && ['rateLimitExceeded', 'userRateLimitExceeded'].includes(item.reason));
            } catch { /* Malformed/provider-specific errors stay sanitized. */ }
          }
        }
        const code: GmailClientErrorCode = response.status === 401 ? 'GMAIL_AUTH_REQUIRED'
          : quota403 ? 'GMAIL_RATE_LIMITED' : response.status === 403 ? 'GMAIL_ACCESS_DENIED' : response.status === 404 ? 'GMAIL_NOT_FOUND'
            : response.status === 429 ? 'GMAIL_RATE_LIMITED' : 'GMAIL_UNAVAILABLE';
        throw new GmailClientError(code, { status: response.status,
          operationMayHaveSucceeded: creating && (response.status >= 500 || response.status < 400 || response.status === 408),
          ...(code === 'GMAIL_RATE_LIMITED' ? { retryAfterMs: retryDelay(response.headers.get('retry-after')) } : {}) });
      }
      if (response.redirected || ![200, ...(creating ? [201] : [])].includes(response.status)
        || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) responseInvalid();
      const declared = response.headers.get('content-length');
      if (declared !== null && !/^\d+$/.test(declared)) responseInvalid();
      if (declared !== null && Number(declared) > this.#maxResponseBytes) {
        throw new GmailClientError('GMAIL_RESPONSE_TOO_LARGE', { operationMayHaveSucceeded: creating });
      }
      if (!response.body) responseInvalid();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await Promise.race([reader.read(), aborted]);
        if (next.done) break;
        size += next.value.byteLength;
        if (size > this.#maxResponseBytes) throw new GmailClientError('GMAIL_RESPONSE_TOO_LARGE', { operationMayHaveSucceeded: creating });
        chunks.push(next.value);
      }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new GmailClientError('GMAIL_RESPONSE_INVALID', { operationMayHaveSucceeded: creating }); }
    } catch (error) {
      if (error instanceof GmailClientError) {
        if (creating && error.code === 'GMAIL_RESPONSE_INVALID' && !error.operationMayHaveSucceeded) {
          throw new GmailClientError(error.code, { operationMayHaveSucceeded: true });
        }
        throw error;
      }
      throw new GmailClientError(controller.signal.aborted ? (timedOut ? 'GMAIL_TIMEOUT' : 'GMAIL_ABORTED') : 'GMAIL_UNAVAILABLE', { operationMayHaveSucceeded: creating });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      // Do not wait on an uncooperative stream's cancellation promise.
      if (reader) void reader.cancel().catch(() => {});
      else if (response?.body) void response.body.cancel().catch(() => {});
      controller.abort();
    }
  }
}
