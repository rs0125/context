'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AgentAccess } from './agent-access';
import { KnowledgeWorkspace } from './knowledge-workspace';
import { ConsoleApiError, consoleRequest, errorMessage, loginErrorMessage } from './helpers';
import { Icon } from './icons';
import { Brand, ConfirmDialog, Notice, Spinner } from './ui';
import type { ConsoleSession } from './types';

function SignIn({ loading, error, message, onRetry, onSignedIn }: {
  loading: boolean; error: string; message: string; onRetry: () => void; onSignedIn: () => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [passwordRejected, setPasswordRejected] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || loading || !password) return;
    setSubmitting(true); setLoginError(''); setPasswordRejected(false);
    try {
      const result = await consoleRequest<{ ok: boolean }>('/api/auth/login', { method: 'POST', body: { password } });
      setPassword('');
      if (result.ok !== true) throw new Error('Unexpected sign-in response');
      await onSignedIn();
    } catch (cause) {
      setLoginError(loginErrorMessage(cause));
      setPasswordRejected(cause instanceof ConsoleApiError && cause.status === 401);
    } finally { setPassword(''); setSubmitting(false); }
  }

  return <div className="login-shell">
    <header className="login-header"><Brand /></header>
    <main className="login-main" id="main-content">
      <section className="login-story">
        <h1>Connect Claude to Wareongo</h1>
        <p className="login-description">Let Claude answer questions using company guides, warehouse listings and CRM records. Access is read-only: Claude cannot change your data.</p>
      </section>
      <section className="login-card" aria-labelledby="login-heading">
        <h2 id="login-heading">Admin sign in</h2>
        <p>Get the connection URL and API key, or edit company guides.</p>
        {message && <Notice tone="info">{message}</Notice>}
        {error && <Notice action={<button className="text-button" onClick={onRetry} disabled={submitting}>Try again</button>}>{error}</Notice>}
        {loading ? <div className="login-loading"><Spinner label="Checking your session…" /></div> : <form className="admin-login-form" method="post" action="/api/auth/login" onSubmit={event => void submit(event)}>
          <label htmlFor="admin-password">Admin password</label>
          <input id="admin-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={event => { setPassword(event.target.value); setPasswordRejected(false); }} disabled={submitting} aria-invalid={passwordRejected} aria-describedby={loginError ? 'admin-login-error' : undefined} />
          {loginError && <div id="admin-login-error"><Notice>{loginError}</Notice></div>}
          <button className="button button-primary full-width" type="submit" disabled={submitting || !password}>{submitting ? <Spinner label="Signing in…" /> : <>Sign in<Icon name="arrow" size={17} /></>}</button>
        </form>}
      </section>
    </main>
    <footer className="login-footer"><span>Wareongo Context</span></footer>
  </div>;
}

export function ConsoleApp() {
  const [session, setSession] = useState<ConsoleSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState<'access' | 'knowledge'>('access');
  const [dirty, setDirty] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const sessionExpired = useCallback(() => { setSession(null); setDirty(false); setTab('access'); setMessage('Your session has ended. Sign in again to continue.'); }, []);
  const loadSession = useCallback(async (signal?: AbortSignal, expectSession = false) => {
    setLoading(true); setError('');
    try { setSession(await consoleRequest<ConsoleSession>('/api/console/me', { signal })); }
    catch (cause) {
      if (signal?.aborted) return;
      setSession(null);
      if (cause instanceof ConsoleApiError && cause.status === 401) {
        if (expectSession) setError('Your session could not be opened. Allow cookies for this site and try again.');
      } else setError(loginErrorMessage(cause));
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController(); void loadSession(controller.signal); return () => controller.abort();
  }, [loadSession]);
  function guard(action: () => void) { if (editorBusy) return; if (dirty) setPendingAction(() => action); else action(); }
  async function logout() {
    setLogoutBusy(true); setError('');
    try {
      await consoleRequest('/api/auth/logout', { method: 'POST' });
      setSession(null); setTab('access'); setDirty(false); setMessage('You’ve signed out.');
    } catch (cause) {
      if (cause instanceof ConsoleApiError && cause.status === 401) sessionExpired();
      else setError(errorMessage(cause));
    } finally { setLogoutBusy(false); }
  }

  if (!session) return <SignIn loading={loading} error={error} message={message} onRetry={() => void loadSession()} onSignedIn={async () => { setMessage(''); await loadSession(undefined, true); }} />;
  const initials = (session.employee.name || session.employee.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(value => value[0]).join('').toUpperCase();
  return <div className="workspace-shell">
    <aside className="workspace-sidebar">
      <div className="sidebar-top"><Brand /><nav className="workspace-nav" aria-label="Workspace">
        <button disabled={editorBusy} className={tab === 'access' ? 'active' : ''} aria-current={tab === 'access' ? 'page' : undefined} onClick={() => { if (tab !== 'access') guard(() => setTab('access')); }}><Icon name="key" />Connect Claude<Icon name="chevron" size={14} /></button>
        {session.employee.isAdmin && <button disabled={editorBusy} className={tab === 'knowledge' ? 'active' : ''} aria-current={tab === 'knowledge' ? 'page' : undefined} onClick={() => { if (tab !== 'knowledge') guard(() => setTab('knowledge')); }}><Icon name="book" />Knowledge</button>}
      </nav></div>
      <div className="sidebar-bottom"><div className="sidebar-account"><span className="avatar">{initials}</span><div><strong>{session.employee.name || 'Team member'}</strong><span>{session.employee.email}</span></div><button className="icon-button" aria-label="Sign out" title="Sign out" disabled={logoutBusy || editorBusy} onClick={() => guard(() => void logout())}><Icon name="logout" size={17} /></button></div></div>
    </aside>
    <div className="workspace-main">
      <header className="workspace-topbar"><div className="breadcrumb"><strong>{tab === 'access' ? 'Connect Claude' : 'Knowledge'}</strong></div>{session.employee.isAdmin && <span className="admin-badge">Administrator</span>}</header>
      <main className="workspace-content" id="main-content">{error && <Notice>{error}</Notice>}{tab === 'access' ? <AgentAccess session={session} onSessionExpired={sessionExpired} /> : <KnowledgeWorkspace writesEnabled={session.capabilities?.writesEnabled === true} onSessionExpired={sessionExpired} onDirtyChange={setDirty} onBusyChange={setEditorBusy} />}</main>
      <footer className="workspace-footer"><span>Wareongo Context</span></footer>
    </div>
    {pendingAction && <ConfirmDialog title="Leave without saving?" confirmLabel="Discard changes" destructive onCancel={() => setPendingAction(null)} onConfirm={() => { const action = pendingAction; setPendingAction(null); action(); }}><p>Your page has unsaved changes. Save them first if you want to keep them.</p></ConfirmDialog>}
  </div>;
}
