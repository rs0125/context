import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GMAIL_COMPOSE_SCOPE, GmailClient, GmailClientError, type GmailCreateDraftInput } from '../src/lib/gmail-client';

const token = 'synthetic-private-token';
const operationId = '1ad22cf9-6897-4600-a53b-7f172b486c39';
const input: GmailCreateDraftInput = {
  from: 'employee@wareongo.com', to: ['client@example.com'], cc: ['colleague@wareongo.com'],
  subject: 'Warehouse shortlist — बेंगलुरु 🏠', body: 'Hello,\nHere are your options.\nRegards', operationId,
};
const internetMessageId = `<wareongo.${createHash('sha256').update(operationId).digest('hex')}@drafts.wareongo.com>`;
const draftIds = { id: 'r-123', message: { id: 'message123', threadId: 'thread123' } };
function fullDraft(overrides: Record<string, unknown> = {}) {
  return {
    ...draftIds,
    message: { ...draftIds.message, payload: {
      mimeType: 'text/plain', headers: [
        { name: 'X-Wareongo-Operation-ID', value: operationId },
        { name: 'Message-ID', value: internetMessageId },
        { name: 'Subject', value: input.subject },
        { name: 'To', value: '"Client, Example" <client@example.com>, other@example.com' },
        { name: 'Cc', value: 'colleague@wareongo.com' },
        { name: 'Content-Type', value: 'text/plain; charset="UTF-8"' },
      ], body: { data: Buffer.from(input.body).toString('base64url'), size: Buffer.byteLength(input.body) },
      ...overrides,
    } },
  };
}
function mockFetch(response: () => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async () => response());
}

describe('draft-only Gmail HTTP adapter', () => {
  it('creates UTF-8 plain-text MIME only at the fixed draft endpoint, with no cache or redirects', async () => {
    const fetch = mockFetch(() => Response.json(draftIds));
    const client = new GmailClient({ fetch });
    const result = await client.createDraft(token, input);
    expect(GMAIL_COMPOSE_SCOPE).toBe('https://www.googleapis.com/auth/gmail.compose');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    const options = fetch.mock.calls[0][1]!;
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const request = JSON.parse(options.body as string);
    expect(Object.keys(request)).toEqual(['message']);
    expect(Object.keys(request.message)).toEqual(['raw']);
    expect(request.message.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const mime = Buffer.from(request.message.raw, 'base64url').toString('utf8');
    const [headerText, bodyText] = mime.split('\r\n\r\n');
    expect(headerText).toContain(`Message-ID: ${internetMessageId}`);
    expect(headerText).toContain(`X-Wareongo-Operation-ID: ${operationId}`);
    expect(headerText).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(headerText).toContain('Content-Transfer-Encoding: base64');
    expect(Buffer.from(bodyText.replace(/\s/g, ''), 'base64').toString()).toBe(input.body.replace(/\n/g, '\r\n'));
    const subjectWords = [...headerText.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)];
    expect(subjectWords.map(word => Buffer.from(word[1], 'base64').toString()).join('')).toBe(input.subject);
    expect(headerText.split('\r\n').every(line => line.length < 998)).toBe(true);
    expect(result).toMatchObject({ id: 'r-123', messageId: 'message123', operationId: null, subject: null, body: null, bodyFormat: 'unsupported' });
    expect(Object.getOwnPropertyNames(GmailClient.prototype).sort()).toEqual(['constructor', 'createDraft', 'findDraftByOperation', 'getDraft']);
  });

  it('supports drafts whose recipients will be filled in Gmail', async () => {
    const fetch = mockFetch(() => Response.json(draftIds));
    await new GmailClient({ fetch }).createDraft(token, { ...input, to: [], cc: [] });
    const mime = Buffer.from(JSON.parse(fetch.mock.calls[0][1]!.body as string).message.raw, 'base64url').toString();
    expect(mime).not.toMatch(/\r\n(?:To|Cc):/);
  });

  it.each([
    { subject: 'Hello\r\nBcc: thief@example.com' },
    { from: 'employee@wareongo.com\r\nBcc: thief@example.com' },
    { to: ['client@example.com\nBcc: thief@example.com'] },
    { cc: ['client@example.com,thief@example.com'] },
    { to: ['Name <client@example.com>'] },
    { operationId: `${operationId}\r\nX-Evil: true` },
    { body: '\0hidden' }, { body: '' }, { body: 'x'.repeat(12_001) },
    { subject: 'x'.repeat(201) }, { to: Array(11).fill('client@example.com') },
    { action: 'send' }, { url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/send' },
    { raw: 'arbitrary MIME' }, { bcc: ['thief@example.com'] }, { html: '<p>HTML</p>' },
    { attachments: [] },
  ])('rejects injected headers and unsupported capabilities before HTTP: %j', async changes => {
    const fetch = mockFetch(() => Response.json(draftIds));
    await expect(new GmailClient({ fetch }).createDraft(token, { ...input, ...changes } as GmailCreateDraftInput))
      .rejects.toMatchObject({ code: 'GMAIL_INVALID_INPUT', operationMayHaveSucceeded: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects path, query, and bearer-token injection before HTTP', async () => {
    const fetch = mockFetch(() => Response.json(draftIds));
    const client = new GmailClient({ fetch });
    for (const id of ['../send', 'r-123/send', 'https://evil.test/', 'r-123?alt=media', '%2fsend', 'r-123#send']) {
      await expect(client.getDraft(token, id)).rejects.toMatchObject({ code: 'GMAIL_INVALID_INPUT' });
    }
    await expect(client.createDraft('secret\r\nX-Extra: value', input)).rejects.toMatchObject({ code: 'GMAIL_INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads bounded saved headers and actual plain text with a GET, preserving quoted mailbox entries', async () => {
    const fetch = mockFetch(() => Response.json(fullDraft()));
    const result = await new GmailClient({ fetch }).getDraft(token, 'r-123');
    expect(fetch.mock.calls[0][0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts/r-123?format=full');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('body');
    expect(result).toMatchObject({ operationId, internetMessageId, subject: input.subject, body: input.body,
      to: ['"Client, Example" <client@example.com>', 'other@example.com'], cc: input.cc, bodyFormat: 'text', bodyTruncated: false });
  });

  it('uses text alternatives, skips attachments, and marks HTML-only bodies unsupported', async () => {
    const responses = [
      fullDraft({ mimeType: 'multipart/mixed', body: {}, parts: [
        { mimeType: 'text/plain', filename: 'private.txt', body: { data: Buffer.from('attachment').toString('base64url') } },
        { mimeType: 'multipart/alternative', parts: [
          { mimeType: 'text/html', body: { data: Buffer.from('<p>HTML</p>').toString('base64url') } },
          { mimeType: 'text/plain', body: { data: Buffer.from('Saved plain text').toString('base64url') } },
        ] },
      ] }),
      fullDraft({ mimeType: 'text/html' }),
      fullDraft({ headers: [{ name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' }] }),
    ];
    const fetch = mockFetch(() => Response.json(responses.shift()));
    const client = new GmailClient({ fetch });
    expect(await client.getDraft(token, 'r-123')).toMatchObject({ body: 'Saved plain text', bodyFormat: 'text' });
    expect(await client.getDraft(token, 'r-123')).toMatchObject({ body: null, bodyFormat: 'unsupported' });
    expect(await client.getDraft(token, 'r-123')).toMatchObject({ body: null, bodyFormat: 'unsupported' });
  });

  it('caps large plain text without splitting a UTF-8 character', async () => {
    const body = `${'x'.repeat(99_999)}🏠suffix`;
    const fetch = mockFetch(() => Response.json(fullDraft({ body: { data: Buffer.from(body).toString('base64url') } })));
    const result = await new GmailClient({ fetch }).getDraft(token, 'r-123');
    expect(result.body).toBe('x'.repeat(99_999));
    expect(result.bodyTruncated).toBe(true);
  });

  it('finds a previous operation using only bounded drafts.list and drafts.get with both identity headers', async () => {
    const fetch = mockFetch(() => Response.json(fetch.mock.calls.length === 1 ? { drafts: [draftIds] } : fullDraft()));
    const result = await new GmailClient({ fetch }).findDraftByOperation(token, operationId);
    expect(result).toMatchObject({ draft: { id: 'r-123', operationId }, complete: true, checked: 1 });
    const url = new URL(fetch.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    expect(url.searchParams.get('q')).toBe(`rfc822msgid:${internetMessageId}`);
    expect(url.searchParams.get('maxResults')).toBe('10');
    expect(fetch.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });

  it('does not accept only one matching header or create again when reconciliation finds nothing', async () => {
    const fetch = mockFetch(() => Response.json(fetch.mock.calls.length === 1
      ? { drafts: [draftIds], nextPageToken: 'more' }
      : fullDraft({ headers: [{ name: 'X-Wareongo-Operation-ID', value: operationId }, { name: 'Message-ID', value: '<different@example.com>' }] })));
    const client = new GmailClient({ fetch });
    expect(await client.findDraftByOperation(token, operationId)).toEqual({ draft: null, complete: false, checked: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
    const emptyFetch = mockFetch(() => Response.json({}));
    expect(await new GmailClient({ fetch: emptyFetch }).findDraftByOperation(token, operationId)).toEqual({ draft: null, complete: true, checked: 0 });
    expect(emptyFetch).toHaveBeenCalledTimes(1);
  });

  it('marks a draft disappearing during reconciliation as incomplete', async () => {
    const fetch = mockFetch(() => fetch.mock.calls.length === 1 ? Response.json({ drafts: [draftIds] }) : new Response('private', { status: 404 }));
    expect(await new GmailClient({ fetch }).findDraftByOperation(token, operationId)).toEqual({ draft: null, complete: false, checked: 1 });
  });

  it.each([
    [401, 'GMAIL_AUTH_REQUIRED', false], [403, 'GMAIL_ACCESS_DENIED', false],
    [404, 'GMAIL_NOT_FOUND', false], [429, 'GMAIL_RATE_LIMITED', false],
    [500, 'GMAIL_UNAVAILABLE', true], [302, 'GMAIL_UNAVAILABLE', true],
  ])('sanitizes HTTP %i errors and does not retry', async (status, code, operationMayHaveSucceeded) => {
    const fetch = mockFetch(() => new Response(`provider echo ${token} private@example.com`, { status }));
    const error = await new GmailClient({ fetch }).createDraft(token, input).catch(error => error);
    expect(error).toBeInstanceOf(GmailClientError);
    expect(error).toMatchObject({ code, status, operationMayHaveSucceeded });
    expect(String(error)).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain('private@example.com');
    expect(error.cause).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats a transport failure or malformed create response as an uncertain write', async () => {
    const network = mockFetch(() => Promise.reject(new Error(`sensitive ${token}`)));
    await expect(new GmailClient({ fetch: network }).createDraft(token, input)).rejects.toMatchObject({ code: 'GMAIL_UNAVAILABLE', operationMayHaveSucceeded: true });
    for (const value of ['not JSON', JSON.stringify({ id: 'r-123' }), JSON.stringify({ ...draftIds, id: '../send' })]) {
      const fetch = mockFetch(() => new Response(value, { headers: { 'Content-Type': 'application/json' } }));
      await expect(new GmailClient({ fetch }).createDraft(token, input)).rejects.toMatchObject({ code: 'GMAIL_RESPONSE_INVALID', operationMayHaveSucceeded: true });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects oversized declared and streaming responses, cancelling streams', async () => {
    const cancelled = vi.fn();
    const declared = mockFetch(() => new Response('private', { headers: { 'Content-Length': '100', 'Content-Type': 'application/json' } }));
    await expect(new GmailClient({ fetch: declared, maxResponseBytes: 20 }).createDraft(token, input))
      .rejects.toMatchObject({ code: 'GMAIL_RESPONSE_TOO_LARGE', operationMayHaveSucceeded: true });
    const streaming = mockFetch(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(21)); }, cancel: cancelled,
    }), { headers: { 'Content-Type': 'application/json' } }));
    await expect(new GmailClient({ fetch: streaming, maxResponseBytes: 20 }).getDraft(token, 'r-123'))
      .rejects.toMatchObject({ code: 'GMAIL_RESPONSE_TOO_LARGE', operationMayHaveSucceeded: false });
    expect(cancelled).toHaveBeenCalled();
  });

  it('enforces deadlines even when fetch or body reading ignores AbortSignal', async () => {
    const never = mockFetch(() => new Promise(() => {}));
    await expect(new GmailClient({ fetch: never, timeoutMs: 5 }).createDraft(token, input))
      .rejects.toMatchObject({ code: 'GMAIL_TIMEOUT', operationMayHaveSucceeded: true });
    const stalled = mockFetch(() => new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } }));
    await expect(new GmailClient({ fetch: stalled, timeoutMs: 5 }).getDraft(token, 'r-123'))
      .rejects.toMatchObject({ code: 'GMAIL_TIMEOUT', operationMayHaveSucceeded: false });
  });

  it('does not dispatch a pre-cancelled request and reports post-dispatch cancellation as uncertain', async () => {
    const controller = new AbortController();
    controller.abort(new Error(token));
    const fetch = mockFetch(() => new Promise(() => {}));
    const client = new GmailClient({ fetch });
    await expect(client.createDraft(token, input, controller.signal)).rejects.toMatchObject({ code: 'GMAIL_ABORTED', operationMayHaveSucceeded: false });
    expect(fetch).not.toHaveBeenCalled();
    const running = new AbortController();
    const request = client.createDraft(token, input, running.signal);
    running.abort(new Error(token));
    await expect(request).rejects.toMatchObject({ code: 'GMAIL_ABORTED', operationMayHaveSucceeded: true });
  });

  it('shares one deadline across reconciliation list and candidate reads', async () => {
    // Each response alone fits 80 ms; together they exceed the complete budget.
    const fetch = vi.fn<typeof globalThis.fetch>(async (): Promise<Response> => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return Response.json(fetch.mock.calls.length === 1 ? { drafts: [draftIds] } : fullDraft());
    });
    await expect(new GmailClient({ fetch, timeoutMs: 80 }).findDraftByOperation(token, operationId))
      .rejects.toMatchObject({ code: 'GMAIL_ABORTED', operationMayHaveSucceeded: false });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });

  it.each([
    () => new Response(JSON.stringify(draftIds), { status: 202, headers: { 'Content-Type': 'application/json' } }),
    () => new Response(JSON.stringify(draftIds), { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(JSON.stringify(draftIds), { headers: { 'Content-Type': 'application/json', 'Content-Length': 'invalid' } }),
  ])('does not confirm creation from an unexpected success response', async response => {
    const fetch = mockFetch(response);
    await expect(new GmailClient({ fetch }).createDraft(token, input))
      .rejects.toMatchObject({ code: 'GMAIL_RESPONSE_INVALID', operationMayHaveSucceeded: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects mismatched IDs, duplicate markers, invalid encodings and excessive MIME nesting', async () => {
    let nested: Record<string, unknown> = { mimeType: 'text/plain', body: { data: 'aGk' } };
    for (let i = 0; i < 10; i++) nested = { mimeType: 'multipart/mixed', parts: [nested] };
    const responses = [
      { ...fullDraft(), id: 'different' },
      fullDraft({ headers: [{ name: 'X-Wareongo-Operation-ID', value: operationId }, { name: 'x-wareongo-operation-id', value: operationId }] }),
      fullDraft({ body: { data: '@@not-base64' } }),
      fullDraft({ body: { data: Buffer.from([0xff]).toString('base64url') } }),
      fullDraft(nested),
    ];
    const fetch = mockFetch(() => Response.json(responses.shift()));
    const client = new GmailClient({ fetch });
    for (let i = 0; i < 5; i++) await expect(client.getDraft(token, 'r-123')).rejects.toMatchObject({ code: 'GMAIL_RESPONSE_INVALID' });
  });
});
