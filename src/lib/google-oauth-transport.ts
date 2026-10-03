/** Server-only OAuth transport. Callers choose a fixed operation, never a URL.
 * Provider error descriptions and token bodies never escape through errors. */
export class GoogleOAuthTransportError extends Error {
  constructor(readonly code: 'unavailable' | 'invalid_grant' | 'aborted') {
    super('Google authorization request could not be completed.');
    this.name = 'GoogleOAuthTransportError';
  }
}

const endpoints = {
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
} as const;

/** Bounded token exchange/refresh and revocation; never automatically retries.
 * Promise.race also bounds a stalled response stream that ignores cancellation. */
export async function googleOAuthPost(operation: keyof typeof endpoints, parameters: URLSearchParams,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
  const unavailable = () => new GoogleOAuthTransportError('unavailable');
  const { signal } = options;
  if (signal?.aborted) throw new GoogleOAuthTransportError('aborted');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, operation === 'revoke' ? 2_000 : 5_000);
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(unavailable());
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    response = await Promise.race([(options.fetch ?? globalThis.fetch)(endpoints[operation], {
      method: 'POST', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: parameters,
    }), aborted]);
    if (response.redirected) throw unavailable();
    // Google documents an empty 200 response for successful revocation.
    if (operation === 'revoke' && response.status === 200) return {};
    if ((response.ok && response.status !== 200)
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw unavailable();
    const maximumBytes = response.ok ? 32_768 : 8_192;
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) throw unavailable();
    if (!response.body) throw unavailable();
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw unavailable();
      chunks.push(value);
    }
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw unavailable();
    if (!response.ok) {
      // Safe to retry revocation after a lost success response.
      if (operation === 'revoke' && response.status === 400 && 'error' in data && data.error === 'invalid_token') return {};
      if (operation === 'token' && [400, 401].includes(response.status) && 'error' in data && data.error === 'invalid_grant') {
        throw new GoogleOAuthTransportError('invalid_grant');
      }
      throw unavailable();
    }
    return data as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GoogleOAuthTransportError) throw error;
    throw unavailable();
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
    controller.abort();
  }
}
