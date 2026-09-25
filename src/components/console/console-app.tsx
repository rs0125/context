'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AgentAccess } from './agent-access';
import { KnowledgeWorkspace } from './knowledge-workspace';
import { ConsoleApiError, consoleRequest, errorMessage } from './helpers';
import { Icon } from './icons';
import { Brand, ConfirmDialog, Notice, Spinner } from './ui';
import type { ConsoleSession } from './types';

function SignIn({ loading, error, message, onRetry, onSignedIn }: {
  loading: boolean; error: string; message: string; onRetry: () => void; onSignedIn: () => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loginError, setLoginError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || loading || !password) return;
    setSubmitting(true); setLoginError('');
    try {
      const result = await consoleRequest<{ ok: boolean }>('/api/auth/login', { method: 'POST', body: { password } });
      setPassword('');
      if (result.ok !== true) throw new Error('Unexpected sign-in response');
      await onSignedIn();
    } catch (cause) {
      if (cause instanceof ConsoleApiError && cause.status === 401) {
        setLoginError('Sign-in failed. Check the admin password and try again.');
      } else if (cause instanceof ConsoleApiError && cause.status === 429) {
        setLoginError('Too many sign-in attempts. Wait a moment and try again.');
      } else if (cause instanceof ConsoleApiError && cause.code === 'CONSOLE_SETUP_REQUIRED') {
        setLoginError('Admin sign-in is not configured yet. Complete workspace setup before trying again.');
      } else {
        setLoginError('Unable to sign in right now. Please try again.');
      }
    } finally { setPassword(''); setSubmitting(false); }
  }

  return <div className="login-shell">
    <header className="login-header"><Brand /><a className="text-link" href="/api/v1/openapi.json">API reference<Icon name="external" size={14} /></a></header>
    <main className="login-main" id="main-content">
      <section className="login-story">
        <p className="eyebrow"><span className="eyebrow-dot" />A LITTLE CONTEXT. A LOT MORE CLARITY.</p>
        <h1>Your company knowledge.<br /><span>Your agent’s advantage.</span></h1>
        <p className="login-description">Bring the right context into the tools you already use. One secure connection to the knowledge and records available to you.</p>
        <div className="context-illustration" aria-hidden="true">
          <div className="illustration-orbit" />
          <div className="illustration-card illustration-knowledge"><span className="illustration-icon"><Icon name="book" size={21} /></span><div><strong>Company knowledge</strong><span>Guides, definitions & processes</span></div><span className="illustration-check"><Icon name="check" size={13} /></span></div>
          <div className="illustration-card illustration-records"><span className="illustration-icon"><Icon name="file" size={21} /></span><div><strong>Warehouse & CRM context</strong><span>The records you can access</span></div><span className="illustration-check"><Icon name="check" size={13} /></span></div>
          <div className="illustration-destination"><span className="destination-icon"><Icon name="code" size={20} /></span><span>Your preferred AI tool</span><span className="destination-signal"><i /><i /><i /></span></div>
          <span className="illustration-caption">CONNECTED THROUGH A READ-ONLY API</span>
        </div>
        <div className="login-assurances"><span><Icon name="shield" size={15} />Private admin access</span><span><Icon name="code" size={15} />REST + Markdown</span></div>
      </section>
      <section className="login-card" aria-labelledby="login-heading">
        <span className="login-symbol"><Icon name="key" size={25} /></span>
        <p className="eyebrow">PRIVATE WORKSPACE</p><h2 id="login-heading">Access the admin workspace.</h2>
        <p>Enter the administrator password to manage knowledge and agent access.</p>
        {message && <Notice tone="info">{message}</Notice>}
        {error && <Notice action={<button className="text-button" onClick={onRetry} disabled={submitting}>Try again</button>}>{error}</Notice>}
        {loading ? <div className="login-loading"><Spinner label="Checking your session…" /></div> : <form className="admin-login-form" method="post" action="/api/auth/login" onSubmit={event => void submit(event)}>
          <label htmlFor="admin-password">Admin password</label>
          <input id="admin-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={submitting} aria-invalid={Boolean(loginError)} aria-describedby={loginError ? 'admin-login-error' : undefined} />
          {loginError && <div id="admin-login-error"><Notice>{loginError}</Notice></div>}
          <button className="button button-primary full-width" type="submit" disabled={submitting || !password}>{submitting ? <Spinner label="Signing in…" /> : <>Sign in<Icon name="arrow" size={17} /></>}</button>
        </form>}
        <p className="login-access-caption">Administrator access only</p>
        <div className="login-card-divider" /><div className="login-note"><Icon name="shield" size={18} /><p>This password opens the admin console. Agent API keys are managed separately inside.</p></div>
      </section>
    </main>
    <footer className="login-footer"><span>Wareongo Context</span><span>Better context. More informed work.</span><a href="/api/health">Service health<Icon name="external" size={12} /></a></footer>
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
      } else setError(errorMessage(cause));
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
  return <div className="workspace-shell"><aside className="workspace-sidebar"><div className="sidebar-top"><Brand /><span className="workspace-label">WORKSPACE</span><nav className="workspace-nav" aria-label="Workspace"><button disabled={editorBusy} className={tab === 'access' ? 'active' : ''} aria-current={tab === 'access' ? 'page' : undefined} onClick={() => { if (tab !== 'access') guard(() => setTab('access')); }}><Icon name="key" />Agent access<Icon name="chevron" size={14} /></button>{session.employee.isAdmin && <button disabled={editorBusy} className={tab === 'knowledge' ? 'active' : ''} aria-current={tab === 'knowledge' ? 'page' : undefined} onClick={() => { if (tab !== 'knowledge') guard(() => setTab('knowledge')); }}><Icon name="book" />Knowledge<small>ADMIN</small></button>}</nav></div><div className="sidebar-bottom"><div className="sidebar-tip"><span><Icon name="shield" size={19} /></span><h3>Context with boundaries.</h3><p>Personal permissions. Read-only requests. Useful answers.</p></div><a className="sidebar-api" href="/api/v1/openapi.json" target="_blank" rel="noreferrer"><Icon name="code" size={16} />API reference<Icon name="external" size={13} /></a><div className="sidebar-account"><span className="avatar">{initials}</span><div><strong>{session.employee.name || 'Team member'}</strong><span>{session.employee.email}</span></div><button className="icon-button" aria-label="Sign out" title="Sign out" disabled={logoutBusy || editorBusy} onClick={() => guard(() => void logout())}><Icon name="logout" size={17} /></button></div></div></aside><div className="workspace-main"><header className="workspace-topbar"><div className="breadcrumb">Workspace<Icon name="chevron" size={13} /><strong>{tab === 'access' ? 'Agent access' : 'Knowledge'}</strong></div><div className="topbar-right"><span className="environment-label"><span />Private workspace</span>{session.employee.isAdmin && <span className="admin-badge">Administrator</span>}</div></header><main className="workspace-content" id="main-content">{error && <Notice>{error}</Notice>}{tab === 'access' ? <AgentAccess session={session} onSessionExpired={sessionExpired} /> : <KnowledgeWorkspace writesEnabled={session.capabilities?.writesEnabled === true} onSessionExpired={sessionExpired} onDirtyChange={setDirty} onBusyChange={setEditorBusy} />}</main><footer className="workspace-footer"><span>Wareongo Context</span><span>Connected knowledge. Considered decisions.</span></footer></div>{pendingAction && <ConfirmDialog title="Leave without saving?" confirmLabel="Discard changes" destructive onCancel={() => setPendingAction(null)} onConfirm={() => { const action = pendingAction; setPendingAction(null); action(); }}><p>Your page has unsaved changes. Save them first if you want to keep them.</p></ConfirmDialog>}</div>;
}
