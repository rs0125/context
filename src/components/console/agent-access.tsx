'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConsoleApiError, consoleRequest, displayDate, errorMessage, makeAgentSetup, makeSystemPrompt } from './helpers';
import { Icon } from './icons';
import { ConfirmDialog, Notice, Spinner } from './ui';
import { SCOPE_OPTIONS, type ConsoleSession, type PersonalKey } from './types';

export function AgentAccess({ session, onSessionExpired }: { session: ConsoleSession; onSessionExpired: () => void }) {
  const [key, setKey] = useState<PersonalKey | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copyError, setCopyError] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState('');
  const [confirmRotation, setConfirmRotation] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRequestSequence = useRef(0);
  const copySequence = useRef(0);
  const writesEnabled = session.capabilities?.writesEnabled === true;
  const prompt = makeSystemPrompt(session.apiBaseUrl);

  const loadKey = useCallback(async (signal?: AbortSignal) => {
    const request = ++keyRequestSequence.current;
    setLoading(true); setError(''); setKey(null); setRevealed(false);
    try {
      const result = await consoleRequest<{ key: PersonalKey | null }>('/api/console/key', { signal });
      if (!signal?.aborted && request === keyRequestSequence.current) setKey(result.key);
    }
    catch (cause) {
      if (signal?.aborted || request !== keyRequestSequence.current) return;
      if (cause instanceof ConsoleApiError && cause.status === 401) onSessionExpired();
      else setError(errorMessage(cause));
    } finally { if (!signal?.aborted && request === keyRequestSequence.current) setLoading(false); }
  }, [onSessionExpired]);

  useEffect(() => {
    if (!writesEnabled) { setLoading(false); return; }
    const controller = new AbortController(); void loadKey(controller.signal);
    return () => controller.abort();
  }, [loadKey, writesEnabled]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy(value: string, label: string) {
    const request = ++copySequence.current;
    setCopyError('');
    try {
      await navigator.clipboard.writeText(value);
      if (request !== copySequence.current) return;
      setCopied(label);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(''), 2500);
    } catch { if (request === copySequence.current) setCopyError('Clipboard access is unavailable. Select and copy the instructions, or reveal your key to copy it manually.'); }
  }

  async function createKey() {
    keyRequestSequence.current += 1;
    copySequence.current += 1;
    setBusy(true); setError('');
    try {
      const result = await consoleRequest<{ key: PersonalKey }>('/api/console/key', { method: 'POST' });
      setKey(result.key); setRevealed(false); setConfirmRotation(false); setCopied('');
    } catch (cause) {
      setConfirmRotation(false);
      if (cause instanceof ConsoleApiError && cause.status === 401) onSessionExpired();
      else setError(errorMessage(cause));
    } finally { setBusy(false); }
  }

  return <div className="access-workspace">
    <div className="page-heading"><div><p className="eyebrow">YOUR WORKSPACE, CONNECTED</p><h1>Give your agent the context.</h1><p>Set up your preferred AI tool with instructions and your personal access key.</p></div><span className="status-pill"><span />Read-only API</span></div>
    {!writesEnabled && <Notice tone="info">Your workspace is ready to explore. Personal keys and knowledge editing will be available when an administrator completes setup.</Notice>}
    {copyError && <Notice>{copyError}</Notice>}
    <div className="access-grid">
      <section className="panel prompt-panel" aria-labelledby="prompt-heading">
        <div className="panel-heading"><div className="step-heading"><span className="step-number">01</span><div><h2 id="prompt-heading">Agent instructions</h2><p>A starting point for useful, grounded answers.</p></div></div><span className="small-tag">SYSTEM PROMPT</span></div>
        <div className="prompt-text-wrap"><textarea className="prompt-text" aria-label="Agent system instructions" value={prompt} readOnly spellCheck={false} /></div>
        <div className="panel-footer"><span className="muted">Add this to your tool’s system instructions.</span><button className="button button-primary" onClick={() => void copy(prompt, 'prompt')}><Icon name={copied === 'prompt' ? 'check' : 'copy'} />{copied === 'prompt' ? 'Copied instructions' : 'Copy instructions'}</button></div>
      </section>
      <div className="access-side">
        <section className="panel key-panel" aria-labelledby="key-heading">
          <div className="step-heading"><span className="step-number">02</span><div><h2 id="key-heading">Personal API key</h2><p>Your access, wherever you work.</p></div></div>
          {error && <Notice action={<button className="text-button" onClick={() => void loadKey()}>Retry</button>}>{error}</Notice>}
          {loading ? <div className="key-loading"><Spinner label="Loading your key…" /></div> : key ? <>
            <label className="field-label" htmlFor="personal-key">API KEY</label>
            <div className="secret-field"><input id="personal-key" type={revealed ? 'text' : 'password'} value={key.token} readOnly autoComplete="off" spellCheck={false} aria-label="Personal API key" /><button className="icon-button" onClick={() => setRevealed(!revealed)} aria-label={revealed ? 'Hide API key' : 'Reveal API key'} aria-pressed={revealed}><Icon name={revealed ? 'eye-off' : 'eye'} /></button></div>
            <div className="key-meta"><span>Expires {displayDate(key.expiresAt)}</span><button className="text-button" disabled={busy || !writesEnabled} onClick={() => setConfirmRotation(true)}><Icon name="refresh" size={13} />Rotate key</button></div>
            <button className="button button-secondary full-width" onClick={() => void copy(key.token, 'key')}><Icon name={copied === 'key' ? 'check' : 'copy'} />{copied === 'key' ? 'Copied API key' : 'Copy API key'}</button>
          </> : <div className="key-empty"><span className="empty-icon"><Icon name="key" size={25} /></span><h3>Your personal connection</h3><p>Create a key to let your agent read the context available to you.</p><button className="button button-primary full-width" disabled={!writesEnabled || busy || Boolean(error)} onClick={() => void createKey()}>{busy ? <Spinner label="Creating…" /> : <><Icon name="plus" />Create API key</>}</button></div>}
          <p className="key-hint"><Icon name="shield" size={15} /><span>Keep this key private. Add it to your tool’s credential settings as a Bearer token.</span></p>
        </section>
        <section className="panel connection-panel" aria-labelledby="connection-heading"><div className="connection-heading"><Icon name="code" /><h2 id="connection-heading">Connection details</h2></div><label className="field-label" htmlFor="api-base">API BASE URL</label><div className="endpoint-field"><input id="api-base" readOnly value={session.apiBaseUrl} aria-label="API base URL" /><button className="icon-button" aria-label="Copy API base URL" onClick={() => void copy(session.apiBaseUrl, 'base')}><Icon name={copied === 'base' ? 'check' : 'copy'} size={16} /></button></div><div className="scope-list" aria-label="Your permissions">{SCOPE_OPTIONS.filter(scope => session.employee.scopes.includes(scope.value)).map(scope => <span className="scope-chip" key={scope.value}><Icon name="check" size={12} />{scope.label}</span>)}</div><a className="text-link" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">View API reference<Icon name="external" size={14} /></a></section>
      </div>
    </div>
    <section className="setup-strip"><div className="setup-strip-icon"><Icon name="arrow" size={23} /></div><div><h2>Ready to connect?</h2><p>Copy both pieces together, then place each in the right settings for your tool. The tool needs authenticated HTTP access.</p></div><button className="button button-secondary" disabled={!key || loading} onClick={() => key && void copy(makeAgentSetup(prompt, key.token), 'setup')}><Icon name={copied === 'setup' ? 'check' : 'copy'} />{copied === 'setup' ? 'Copied setup' : 'Copy complete setup'}</button></section>
    <div className="access-footnote"><Icon name="shield" size={15} /><p>Agents can read permitted context. They cannot change records or take actions through this API.</p></div>
    <span className="sr-only" role="status" aria-live="polite">{copied ? `${copied === 'base' ? 'API base URL' : copied} copied to clipboard` : ''}</span>
    {confirmRotation && <ConfirmDialog title="Rotate your API key?" confirmLabel="Rotate key" destructive busy={busy} onCancel={() => setConfirmRotation(false)} onConfirm={() => void createKey()}><p>Your current key will stop working. Update every tool that uses it with the new key.</p></ConfirmDialog>}
  </div>;
}
