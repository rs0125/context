'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConsentView } from './consent-view';
import { authorizationError, authorizationQuery, authorizationRedirect, oauthRequest, readAuthorizationPreview, type AuthorizationPreview } from './helpers';

export function AuthorizeApp() {
  const [preview, setPreview] = useState<AuthorizationPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const request = ++sequence.current;
    setLoading(true); setError(''); setPreview(null);
    try {
      const query = authorizationQuery(window.location.search);
      const value = await oauthRequest(query, undefined, signal);
      if (signal?.aborted || request !== sequence.current) return;
      setPreview(readAuthorizationPreview(value, window.location.origin));
    } catch (cause) {
      if (!signal?.aborted && request === sequence.current) setError(authorizationError(cause));
    } finally { if (!signal?.aborted && request === sequence.current) setLoading(false); }
  }, []);

  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function decide(approve: boolean, apiKey?: string) {
    if (!preview) throw new Error('The connection request is unavailable. Start again from your AI tool.');
    try {
      const value = await oauthRequest(undefined, { requestHandle: preview.requestHandle, approve, ...(approve ? { apiKey } : {}) });
      const target = authorizationRedirect(value, preview);
      if (apiKey && (target.includes(apiKey) || target.includes(encodeURIComponent(apiKey)))) throw new Error('Invalid authorization response');
      window.location.assign(target);
    } catch (cause) { throw new Error(authorizationError(cause)); }
  }

  return <ConsentView details={preview} loading={loading} error={error} onRetry={() => void load()} onConnect={apiKey => decide(true, apiKey)} onCancel={() => decide(false)} />;
}
