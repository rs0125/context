'use client';

import { useCallback, useEffect, useState } from 'react';
import { AgentAccess } from './agent-access';
import { KnowledgeWorkspace } from './knowledge-workspace';
import { ConsoleApiError, consoleRequest, errorMessage } from './helpers';
import { Icon } from './icons';
import { Brand, ConfirmDialog, Notice, Spinner } from './ui';
import type { ConsoleSession } from './types';

function GoogleMark() {
  return <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.61 4.61 0 0 1-2 3.03v2.52h3.24c1.9-1.75 2.98-4.32 2.98-7.38Z" /><path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.61-2.39l-3.24-2.52c-.9.6-2.04.97-3.37.97-2.6 0-4.81-1.76-5.6-4.13H3.05v2.6A10 10 0 0 0 12 22Z" /><path fill="#FBBC05" d="M6.4 13.93a6 6 0 0 1 0-3.86v-2.6H3.05a10 10 0 0 0 0 9.06l3.35-2.6Z" /><path fill="#EA4335" d="M12 5.94c1.47 0 2.79.5 3.82 1.5l2.86-2.86A9.59 9.59 0 0 0 12 2a10 10 0 0 0-8.95 5.47l3.35 2.6A5.98 5.98 0 0 1 12 5.94Z" /></svg>;
}

function SignIn({ loading, error, message, onRetry }: { loading: boolean; error: string; message: string; onRetry: () => void }) {
  return <div className="login-shell"><header className="login-header"><Brand /><a className="text-link" href="/api/v1/openapi.json">API reference<Icon name="external" size={14} /></a></header><main className="login-main" id="main-content"><section className="login-story"><p className="eyebrow"><span className="eyebrow-dot" />A LITTLE CONTEXT. A LOT MORE CLARITY.</p><h1>Your company knowledge.<br /><span>Your agent’s advantage.</span></h1><p className="login-description">Bring the right context into the tools you already use. One secure connection to the knowledge and records available to you.</p><div className="context-illustration" aria-hidden="true"><div className="illustration-orbit" /><div className="illustration-card illustration-knowledge"><span className="illustration-icon"><Icon name="book" size={21} /></span><div><strong>Company knowledge</strong><span>Guides, definitions & processes</span></div><span className="illustration-check"><Icon name="check" size={13} /></span></div><div className="illustration-card illustration-records"><span className="illustration-icon"><Icon name="file" size={21} /></span><div><strong>Warehouse & CRM context</strong><span>The records you can access</span></div><span className="illustration-check"><Icon name="check" size={13} /></span></div><div className="illustration-destination"><span className="destination-icon"><Icon name="code" size={20} /></span><span>Your preferred AI tool</span><span className="destination-signal"><i /><i /><i /></span></div><span className="illustration-caption">CONNECTED THROUGH A READ-ONLY API</span></div><div className="login-assurances"><span><Icon name="shield" size={15} />Employee permissions</span><span><Icon name="code" size={15} />REST + Markdown</span></div></section><section className="login-card" aria-labelledby="login-heading"><span className="login-symbol"><Icon name="key" size={25} /></span><p className="eyebrow">WAREONGO CONTEXT</p><h2 id="login-heading">Your workspace starts here.</h2><p>Sign in with your work account to set up agent access and manage your context.</p>{message && <Notice tone="info">{message}</Notice>}{error && <Notice action={<button className="text-button" onClick={onRetry}>Try again</button>}>{error}</Notice>}{loading ? <div className="login-loading"><Spinner label="Checking your session…" /></div> : <a href="/api/auth/google" className="button google-button"><GoogleMark />Continue with Google<Icon name="arrow" size={17} /></a>}<p className="login-domain">Use your <strong>@wareongo.com</strong> account</p><div className="login-card-divider" /><div className="login-note"><Icon name="shield" size={18} /><p>Your agent gets permitted context through a personal key. Your Google session stays in this workspace.</p></div></section></main><footer className="login-footer"><span>Wareongo Context</span><span>Better context. More informed work.</span><a href="/api/health">Service health<Icon name="external" size={12} /></a></footer></div>;
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
  const loadSession = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError('');
    try { setSession(await consoleRequest<ConsoleSession>('/api/console/me', { signal })); }
    catch (cause) {
      if (signal?.aborted) return;
      setSession(null);
      if (!(cause instanceof ConsoleApiError && cause.status === 401)) setError(errorMessage(cause));
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('auth_error')) {
      setMessage('Sign-in couldn’t be completed. Try again with your Wareongo work account.');
      window.history.replaceState(null, '', window.location.pathname);
    }
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

  if (!session) return <SignIn loading={loading} error={error} message={message} onRetry={() => void loadSession()} />;
  const initials = (session.employee.name || session.employee.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(value => value[0]).join('').toUpperCase();
  return <div className="workspace-shell"><aside className="workspace-sidebar"><div className="sidebar-top"><Brand /><span className="workspace-label">WORKSPACE</span><nav className="workspace-nav" aria-label="Workspace"><button disabled={editorBusy} className={tab === 'access' ? 'active' : ''} aria-current={tab === 'access' ? 'page' : undefined} onClick={() => { if (tab !== 'access') guard(() => setTab('access')); }}><Icon name="key" />Agent access<Icon name="chevron" size={14} /></button>{session.employee.isAdmin && <button disabled={editorBusy} className={tab === 'knowledge' ? 'active' : ''} aria-current={tab === 'knowledge' ? 'page' : undefined} onClick={() => { if (tab !== 'knowledge') guard(() => setTab('knowledge')); }}><Icon name="book" />Knowledge<small>ADMIN</small></button>}</nav></div><div className="sidebar-bottom"><div className="sidebar-tip"><span><Icon name="shield" size={19} /></span><h3>Context with boundaries.</h3><p>Personal permissions. Read-only requests. Useful answers.</p></div><a className="sidebar-api" href="/api/v1/openapi.json" target="_blank" rel="noreferrer"><Icon name="code" size={16} />API reference<Icon name="external" size={13} /></a><div className="sidebar-account"><span className="avatar">{initials}</span><div><strong>{session.employee.name || 'Team member'}</strong><span>{session.employee.email}</span></div><button className="icon-button" aria-label="Sign out" title="Sign out" disabled={logoutBusy || editorBusy} onClick={() => guard(() => void logout())}><Icon name="logout" size={17} /></button></div></div></aside><div className="workspace-main"><header className="workspace-topbar"><div className="breadcrumb">Workspace<Icon name="chevron" size={13} /><strong>{tab === 'access' ? 'Agent access' : 'Knowledge'}</strong></div><div className="topbar-right"><span className="environment-label"><span />Private workspace</span>{session.employee.isAdmin && <span className="admin-badge">Administrator</span>}</div></header><main className="workspace-content" id="main-content">{error && <Notice>{error}</Notice>}{tab === 'access' ? <AgentAccess session={session} onSessionExpired={sessionExpired} /> : <KnowledgeWorkspace writesEnabled={session.capabilities?.writesEnabled === true} onSessionExpired={sessionExpired} onDirtyChange={setDirty} onBusyChange={setEditorBusy} />}</main><footer className="workspace-footer"><span>Wareongo Context</span><span>Connected knowledge. Considered decisions.</span></footer></div>{pendingAction && <ConfirmDialog title="Leave without saving?" confirmLabel="Discard changes" destructive onCancel={() => setPendingAction(null)} onConfirm={() => { const action = pendingAction; setPendingAction(null); action(); }}><p>Your page has unsaved changes. Save them first if you want to keep them.</p></ConfirmDialog>}</div>;
}
