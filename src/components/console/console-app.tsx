'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentAccess } from './agent-access';
import { KnowledgeWorkspace } from './knowledge-workspace';
import { consoleAccessEnded, consoleRequest, consoleSessionKey, errorMessage, googleSignInError, loginErrorMessage } from './helpers';
import { Icon } from './icons';
import { Brand, ConfirmDialog, Notice, Spinner } from './ui';
import type { ConsoleSession } from './types';

function SignIn({ loading, error, message, onRetry }: {
  loading: boolean; error: string; message: string; onRetry: () => void;
}) {
  return <div className="login-shell">
    <header className="login-header"><Brand /><span className="header-classification">For the Wareongo team</span></header>
    <main className="login-main" id="main-content">
      <section className="login-story">
        <p className="eyebrow">Your AI workspace</p>
        <h1>Your company,<br /><span>in context.</span></h1>
        <p className="login-description">Connect Claude or another compatible AI tool to the company knowledge, warehouse details and CRM records available to you.</p>
        <dl className="login-sources" aria-label="Context sources">
          <div><dt><Icon name="book" size={17} />Company guides</dt><dd>Reviewed knowledge</dd></div>
          <div><dt><Icon name="file" size={17} />Warehouse listings</dt><dd>Property details</dd></div>
          <div><dt><Icon name="shield" size={17} />CRM records</dt><dd>Your permitted leads</dd></div>
        </dl>
      </section>
      <section className="login-card" aria-labelledby="login-heading">
        <p className="eyebrow">Employee access</p>
        <h2 id="login-heading">Sign in with your work account</h2>
        <p>Use your <strong>@wareongo.com</strong> Google account. Then follow three steps to connect your AI tool.</p>
        {message && <Notice tone="info">{message}</Notice>}
        {error && <Notice action={<button className="text-button" onClick={onRetry}>Try again</button>}>{error}</Notice>}
        {loading ? <div className="login-loading"><Spinner label="Checking your session…" /></div> : <a className="button button-primary full-width google-sign-in" href="/api/auth/login">Continue with Google<Icon name="arrow" size={17} /></a>}
        <div className="login-note"><Icon name="shield" size={18} /><p>Your connection follows your employee permissions. Your AI can read context, but cannot change records.</p></div>
      </section>
    </main>
    <footer className="login-footer"><span>Wareongo Context</span><span>Read-only context for AI tools</span></footer>
  </div>;
}

export function ConsoleApp() {
  const [session, setSession] = useState<ConsoleSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [callbackError, setCallbackError] = useState('');
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState<'access' | 'knowledge'>('access');
  const [dirty, setDirty] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [keyRevision, setKeyRevision] = useState(0);
  const sessionRef = useRef<ConsoleSession | null>(null);
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);

  const sessionExpired = useCallback(() => {
    generation.current += 1; inFlight.current = null; sessionRef.current = null;
    setSession(null); setLoading(false); setDirty(false); setEditorBusy(false); setPendingAction(null); setTab('access');
    setMessage('Your session or access has changed. Sign in again to continue.');
  }, []);
  const loadSession = useCallback((signal?: AbortSignal) => {
    if (inFlight.current) return inFlight.current;
    const request = generation.current;
    if (!sessionRef.current) setLoading(true);
    const work = (async () => {
      try {
        const next = await consoleRequest<ConsoleSession>('/api/console/me', { signal });
        if (signal?.aborted || request !== generation.current) return;
        const previous = sessionRef.current;
        const nextKey = consoleSessionKey(next);
        if (previous && consoleSessionKey(previous) !== nextKey) {
          setDirty(false); setTab('access'); setPendingAction(null); setEditorBusy(false);
        }
        sessionRef.current = next; setSession(next); setError(''); setCallbackError(''); setMessage('');
        // Identical metadata is ignored by other tabs, preventing refresh loops.
        channel.current?.postMessage({ type: 'identity', sessionKey: nextKey });
      } catch (cause) {
        if (signal?.aborted || request !== generation.current) return;
        if (consoleAccessEnded(cause)) {
          if (sessionRef.current) sessionExpired();
          else setSession(null);
        } else setError(loginErrorMessage(cause));
      } finally {
        if (!signal?.aborted && request === generation.current) setLoading(false);
      }
    })();
    inFlight.current = work;
    void work.finally(() => { if (inFlight.current === work) inFlight.current = null; });
    return work;
  }, [sessionExpired]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('error')) {
      setCallbackError(googleSignInError(url.searchParams.get('error')));
      url.searchParams.delete('error');
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
    const refresh = () => { if (document.visibilityState === 'visible') void loadSession(); };
    if (typeof BroadcastChannel !== 'undefined') {
      const connection = new BroadcastChannel('wareongo-console-lifecycle'); channel.current = connection;
      connection.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (!data || typeof data !== 'object') return;
        const event = data as { type?: string; sessionKey?: string };
        if (event.type === 'signed-out') { sessionExpired(); return; }
        if (typeof event.sessionKey !== 'string' || event.sessionKey.length > 1024) return;
        if (event.type === 'key-changed') {
          if (sessionRef.current && event.sessionKey === consoleSessionKey(sessionRef.current)) setKeyRevision(value => value + 1);
        } else if (event.type === 'identity' && (!sessionRef.current || event.sessionKey !== consoleSessionKey(sessionRef.current))) {
          sessionExpired(); refresh();
        }
      };
    }
    window.addEventListener('focus', refresh); window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', refresh);
    const controller = new AbortController(); void loadSession(controller.signal);
    return () => {
      controller.abort(); generation.current += 1; inFlight.current = null;
      window.removeEventListener('focus', refresh); window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', refresh);
      channel.current?.close(); channel.current = null;
    };
  }, [loadSession, sessionExpired]);
  const keyChanged = useCallback(() => {
    if (sessionRef.current) channel.current?.postMessage({ type: 'key-changed', sessionKey: consoleSessionKey(sessionRef.current) });
  }, []);
  function guard(action: () => void) { if (editorBusy) return; if (dirty) setPendingAction(() => action); else action(); }
  async function logout() {
    setLogoutBusy(true); setError('');
    try {
      await consoleRequest('/api/auth/logout', { method: 'POST' });
      sessionExpired(); setMessage('You’ve signed out.'); channel.current?.postMessage({ type: 'signed-out' });
    } catch (cause) {
      if (consoleAccessEnded(cause)) sessionExpired();
      else setError(errorMessage(cause));
    } finally { setLogoutBusy(false); }
  }

  if (!session) return <SignIn loading={loading} error={error || callbackError} message={message} onRetry={() => { setCallbackError(''); void loadSession(); }} />;
  const initials = (session.employee.name || session.employee.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(value => value[0]).join('').toUpperCase();
  return <div className="workspace-shell">
    <header className="workspace-header"><div className="workspace-header-inner">
      <Brand /><nav className="workspace-nav" aria-label="Workspace">
        <button disabled={editorBusy} className={tab === 'access' ? 'active' : ''} aria-current={tab === 'access' ? 'page' : undefined} onClick={() => { if (tab !== 'access') guard(() => setTab('access')); }}><Icon name="key" size={16} />Connect Claude</button>
        {session.employee.isAdmin && <button disabled={editorBusy} className={tab === 'knowledge' ? 'active' : ''} aria-current={tab === 'knowledge' ? 'page' : undefined} onClick={() => { if (tab !== 'knowledge') guard(() => setTab('knowledge')); }}><Icon name="book" />Knowledge</button>}
      </nav>
      <div className="workspace-account"><span className="avatar" aria-hidden="true">{initials}</span><div><strong>{session.employee.name || 'Team member'}</strong><span>{session.employee.email}</span></div><button className="icon-button" aria-label="Sign out" title="Sign out" disabled={logoutBusy || editorBusy} onClick={() => guard(() => void logout())}><Icon name="logout" size={17} /></button></div>
    </div></header>
    <div className="workspace-main">
      <div className="workspace-topbar"><p className="eyebrow">Workspace <span aria-hidden="true">/</span> {tab === 'access' ? 'Connections' : 'Knowledge'}</p>{session.employee.isAdmin && <span className="admin-badge">Administrator</span>}</div>
      <main className="workspace-content" id="main-content">{error && <Notice>{error}</Notice>}{tab === 'access' ? <AgentAccess key={`${consoleSessionKey(session)}:${keyRevision}`} session={session} onSessionExpired={sessionExpired} onKeyChanged={keyChanged} /> : <KnowledgeWorkspace key={consoleSessionKey(session)} writesEnabled={session.capabilities?.writesEnabled === true} onSessionExpired={sessionExpired} onDirtyChange={setDirty} onBusyChange={setEditorBusy} />}</main>
      <footer className="workspace-footer"><span>Wareongo Context</span><span><Icon name="shield" size={14} />Read-only access for AI tools</span></footer>
    </div>
    {pendingAction && <ConfirmDialog title="Leave without saving?" confirmLabel="Discard changes" destructive onCancel={() => setPendingAction(null)} onConfirm={() => { const action = pendingAction; setPendingAction(null); action(); }}><p>Your page has unsaved changes. Save them first if you want to keep them.</p></ConfirmDialog>}
  </div>;
}
