'use client';

import { useCallback, useEffect, useState } from 'react';
import { Brand, Notice, Spinner } from '@/components/console/ui';

type ConnectionState = {
  employee: { email: string; name: string };
  connection: { connected: boolean; status: 'active' | 'disconnected' | 'needs_reauth' | 'revoking'; accountEmail: string | null; updatedAt: string | null };
  availability: { enabled: boolean; configured: boolean; available: boolean };
};
const errors: Record<string, string> = {
  cancelled: 'Gmail connection was cancelled. Your existing connection was not changed.',
  scope: 'Allow Gmail draft access on the Google consent screen to connect your mailbox.',
  scope_excess: 'Google returned additional permissions. Remove this app’s existing access in your Google Account, then reconnect.',
  changed: 'Your connection changed while Google was open. Start the connection again.',
  disconnect_pending: 'Ramesh has stopped using this mailbox. Finish disconnecting from Google below before reconnecting.',
  denied: 'Connect the same authorized @wareongo.com account you used to sign in.',
  expired: 'The connection link or sign-in session expired. Sign in and try again.',
  unavailable: 'Gmail connection is temporarily unavailable. Try again shortly.',
};

export function MailConnection() {
  const [state, setState] = useState<ConnectionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedOut, setSignedOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [returnedFromGoogle, setReturnedFromGoogle] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch('/api/mail/connection', { cache: 'no-store', credentials: 'same-origin', signal });
      if (signal?.aborted) return;
      if (response.status === 401 || response.status === 403) { setSignedOut(true); setState(null); return; }
      if (!response.ok) throw new Error('unavailable');
      const next = await response.json() as ConnectionState;
      if (signal?.aborted) return;
      setState(next); setSignedOut(false);
    } catch {
      if (!signal?.aborted) setError('Could not check your Gmail connection. Please try again.');
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('error')) setError(errors[url.searchParams.get('error') ?? ''] ?? errors.unavailable);
    setReturnedFromGoogle(url.searchParams.get('connected') === '1');
    if (url.search) window.history.replaceState(window.history.state, '', '/mail');
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  async function disconnect() {
    if (busy) return;
    setBusy(true); setError(''); setMessage(''); setReturnedFromGoogle(false);
    try {
      const response = await fetch('/api/mail/connection', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401 || response.status === 403) { setSignedOut(true); setState(null); return; }
      if (!response.ok) throw new Error('unavailable');
      const result = await response.json() as { revocationPending: boolean; googleGrantRevoked: boolean };
      setMessage(result.revocationPending
        ? 'Ramesh has stopped using this mailbox, but Google could not finish removing access. Retry disconnect below. Existing drafts are unchanged.'
        : result.googleGrantRevoked ? 'Disconnected from Ramesh and removed the app’s Google access. Existing drafts are unchanged.'
          : 'Disconnected from Ramesh. Existing drafts are unchanged. Check Google account permissions if you previously connected this app.');
      await load();
    } catch { setError('Could not disconnect Gmail. Please try again.'); }
    finally { setBusy(false); }
  }
  const pending = state?.connection.status === 'revoking';
  const reconnectRequired = state?.connection.status === 'needs_reauth';
  return <div className="login-shell">
    <header className="login-header"><Brand /><a className="text-button" href="/">Context console</a></header>
    <main id="main-content" className="login-main">
      <section className="login-story">
        <p className="eyebrow">Ramesh · Gmail</p>
        <h1>Your email drafts,<br /><span>ready to review.</span></h1>
        <p className="login-description">Ask Ramesh on WhatsApp to prepare an email. The draft appears in your work Gmail, where you review, edit and send it yourself.</p>
        <p>Ramesh creates drafts and reads drafts it created. It does not send email.</p>
      </section>
      <section className="login-card" aria-labelledby="mail-heading">
        <p className="eyebrow">Your work mailbox</p>
        <h2 id="mail-heading">{pending ? 'Finish disconnecting Gmail' : reconnectRequired ? 'Reconnect Gmail' : state?.connection.connected ? 'Gmail is connected' : 'Connect Gmail'}</h2>
        {returnedFromGoogle && !loading && state?.connection.connected && <Notice tone="info">Gmail connected. You can return to Ramesh on WhatsApp.</Notice>}
        {message && <Notice tone="info">{message}</Notice>}
        {error && <Notice action={<button className="text-button" onClick={() => { setError(''); void load(); }}>Check again</button>}>{error}</Notice>}
        {loading ? <Spinner label="Checking Gmail connection…" /> : signedOut ? <>
          <p>Sign in with your @wareongo.com account, then connect that same mailbox.</p>
          <a className="button button-primary full-width" href="/api/mail/login">Sign in with Google</a>
        </> : state ? <>
          <p>Signed in as <strong>{state.employee.email}</strong>.</p>
          {state.connection.connected && <p>Connected mailbox: <strong>{state.connection.accountEmail}</strong>.</p>}
          {reconnectRequired && <Notice tone="info">Google access expired or was removed. Reconnect your work Gmail account before asking Ramesh to create or read a draft.</Notice>}
          {pending && <Notice tone="info">Ramesh cannot use this mailbox. Retry disconnect to finish removing the Google permission, then reconnect if needed.</Notice>}
          <p>Google bundles managing drafts and sending email into one permission. You will see both on its consent screen; Ramesh only supports creating and reading its own drafts.</p>
          {state.availability.available ? !pending && <form method="post" action="/api/mail/google/connect">
            <button className="button button-primary full-width" type="submit" disabled={busy}>{state.connection.connected || reconnectRequired ? 'Reconnect Gmail' : 'Connect work Gmail'}</button>
          </form> : <Notice tone="info">Gmail drafts are not enabled or configured yet. Your administrator can finish setup.</Notice>}
          {(state.connection.connected || pending || reconnectRequired) && <>
            <button className="button button-secondary full-width" type="button" onClick={() => void disconnect()} disabled={busy}>{busy ? 'Disconnecting…' : pending ? 'Retry disconnect' : 'Disconnect Gmail'}</button>
            <p>Disconnect also removes this Google app’s permissions. Other Google features sharing this app may need reconnecting.</p>
          </>}
          <p><a href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer">Manage Google account permissions</a></p>
          <p>After connecting, return to WhatsApp. Find prepared messages in Gmail’s Drafts folder.</p>
        </> : null}
        <p>If Google sign-in is blocked inside WhatsApp, open this page in Chrome or Safari and try again.</p>
      </section>
    </main>
    <footer className="login-footer"><span>Wareongo Context</span><span>You review and send every email</span></footer>
  </div>;
}
