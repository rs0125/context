'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { consoleAccessEnded, consoleRequest, displayDate, errorMessage, makeSystemPrompt, mcpServerUrl } from './helpers';
import { Icon } from './icons';
import { ConfirmDialog, Notice, Spinner } from './ui';
import { SCOPE_OPTIONS, type ConsoleSession, type PersonalKey } from './types';
import styles from './agent-access.module.css';

export function AgentAccess({ session, onSessionExpired, onKeyChanged }: { session: ConsoleSession; onSessionExpired: () => void; onKeyChanged: () => void }) {
  const [key, setKey] = useState<PersonalKey | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copyError, setCopyError] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState('');
  const [confirmRotation, setConfirmRotation] = useState(false);
  const [expired, setExpired] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRequestSequence = useRef(0);
  const copySequence = useRef(0);
  const writesEnabled = session.capabilities?.writesEnabled === true;
  const prompt = makeSystemPrompt(session.apiBaseUrl);
  const mcpUrl = mcpServerUrl(session.apiBaseUrl);
  const effectiveScopes = key ? key.scopes.filter(scope => session.employee.scopes.includes(scope)) : session.employee.scopes;
  const missingScopes = key ? SCOPE_OPTIONS.filter(scope => session.employee.scopes.includes(scope.value) && !key.scopes.includes(scope.value)) : [];
  const expireKey = useCallback(() => { setKey(null); setRevealed(false); setExpired(true); setCopied(''); }, []);

  const loadKey = useCallback(async (signal?: AbortSignal) => {
    const request = ++keyRequestSequence.current;
    setLoading(true); setError(''); setKey(null); setRevealed(false);
    try {
      const result = await consoleRequest<{ key: PersonalKey | null }>('/api/console/key', { signal });
      if (!signal?.aborted && request === keyRequestSequence.current) {
        if (result.key && Date.parse(result.key.expiresAt) <= Date.now()) expireKey();
        else { setKey(result.key); if (result.key) setExpired(false); }
      }
    }
    catch (cause) {
      if (signal?.aborted || request !== keyRequestSequence.current) return;
      if (consoleAccessEnded(cause)) onSessionExpired();
      else setError(errorMessage(cause));
    } finally { if (!signal?.aborted && request === keyRequestSequence.current) setLoading(false); }
  }, [onSessionExpired, expireKey]);

  useEffect(() => {
    if (!writesEnabled) { setLoading(false); return; }
    const controller = new AbortController();
    let started = false;
    const start = () => { if (!started && document.visibilityState === 'visible') { started = true; void loadKey(controller.signal); } };
    start(); document.addEventListener('visibilitychange', start); window.addEventListener('focus', start);
    return () => { controller.abort(); document.removeEventListener('visibilitychange', start); window.removeEventListener('focus', start); };
  }, [loadKey, writesEnabled]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!key) return;
    let expiryTimer: ReturnType<typeof setTimeout>;
    const check = () => {
      const remaining = Date.parse(key.expiresAt) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) expireKey();
      else expiryTimer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    };
    check(); return () => clearTimeout(expiryTimer);
  }, [key, expireKey]);

  async function copy(value: string, label: string) {
    if (label === 'key' && (!key || Date.parse(key.expiresAt) <= Date.now())) { expireKey(); return; }
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
      setKey(result.key); setExpired(false); setRevealed(false); setConfirmRotation(false); setCopied(''); onKeyChanged();
    } catch (cause) {
      setConfirmRotation(false);
      // A network failure may happen after rotation committed. Reload before
      // offering a previous key whose validity can no longer be established.
      setKey(null); setRevealed(false); onKeyChanged();
      if (consoleAccessEnded(cause)) onSessionExpired();
      else setError(errorMessage(cause));
    } finally { setBusy(false); }
  }

  return <div className={styles.workspace}>
    <header className={styles.intro}>
      <p className={styles.label}>Agent connection</p>
      <h1>Connect Claude to Wareongo</h1>
      <p className={styles.description}>Connect once to ask Claude about your company guides, warehouses and CRM records. Your employee permissions determine what it can read.</p>
    </header>
    <div className={styles.layout}>
    <div className={styles.instructions}>
    {!writesEnabled && <Notice tone="info">Connections are not available yet. An administrator needs to finish server setup.</Notice>}
    {copyError && <Notice>{copyError}</Notice>}
    <ol className={styles.steps} aria-label="Connect Claude in three steps">
      <li className={styles.step}>
        <span className={styles.number} aria-hidden="true">01</span>
        <section aria-labelledby="add-connector-heading">
          <div className={styles.stepTitle}><h2 id="add-connector-heading">Add the connector in Claude</h2><a className="text-link" href="https://claude.ai" target="_blank" rel="noreferrer">Open Claude<Icon name="external" size={14} /></a></div>
          <p>Go to <strong>Customize → Connectors → + → Add custom connector</strong>.</p>
          <p>Name it <strong>Wareongo Context</strong> and paste this URL:</p>
          <label className={styles.fieldLabel} htmlFor="mcp-url">Connector URL</label>
          <div className={styles.copyRow}><input id="mcp-url" readOnly value={mcpUrl} /><button className="button button-secondary" onClick={() => void copy(mcpUrl, 'url')}><Icon name={copied === 'url' ? 'check' : 'copy'} size={16} />{copied === 'url' ? 'Copied URL' : 'Copy URL'}</button></div>
          <p className={styles.hint}>Leave OAuth Client ID and Client Secret blank, then click <strong>Add</strong>.</p>
        </section>
      </li>
      <li className={styles.step}>
        <span className={styles.number} aria-hidden="true">02</span>
        <section aria-labelledby="connect-account-heading">
          <h2 id="connect-account-heading">Connect your account</h2>
          <p>Click <strong>Connect</strong> beside Wareongo Context in Claude. On the Wareongo page that opens, paste this key and click <strong>Connect</strong>.</p>
          <p className={styles.identity}>This key gives access as <strong>{session.employee.email}</strong>.</p>
          {error && <Notice action={<button className="text-button" onClick={() => void loadKey()}>Retry</button>}>{error}</Notice>}
          {expired && <Notice tone="info">Your API key has expired. Create a new key, then reconnect Claude with it.</Notice>}
          {missingScopes.length > 0 && <Notice tone="info" action={<button className="text-button" disabled={busy} onClick={() => setConfirmRotation(true)}>Replace key</button>}>Your account now includes {missingScopes.map(scope => scope.label).join(', ')}, but this key does not. Replace it and reconnect Claude to use the new access.</Notice>}
          {loading ? <div className={styles.keyState}><Spinner label="Loading your key…" /></div> : key ? <>
            <label className={styles.fieldLabel} htmlFor="personal-key">Employee API key</label>
            <div className={styles.copyRow}><div className={styles.secretField}><input id="personal-key" type={revealed ? 'text' : 'password'} value={key.token} readOnly autoComplete="off" spellCheck={false} /><button className="icon-button" onClick={() => setRevealed(!revealed)} aria-label={revealed ? 'Hide API key' : 'Reveal API key'} aria-pressed={revealed}><Icon name={revealed ? 'eye-off' : 'eye'} /></button></div><button className="button button-primary" disabled={busy} onClick={() => void copy(key.token, 'key')}><Icon name={copied === 'key' ? 'check' : 'copy'} size={16} />{copied === 'key' ? 'Copied key' : 'Copy key'}</button></div>
            <p className={styles.hint}>This key goes on the Wareongo connection page, never in chat.</p>
            <details className={styles.keySettings}><summary>Key settings</summary><div><span>Expires {displayDate(key.expiresAt)}</span><button className="text-button" disabled={busy || !writesEnabled} onClick={() => setConfirmRotation(true)}>Replace key</button></div></details>
          </> : <div className={styles.keyState}><p>Create your employee key to complete this step.</p><button className="button button-primary" aria-label={busy ? 'Creating…' : undefined} disabled={!writesEnabled || busy || Boolean(error)} onClick={() => void createKey()}>{busy ? <Spinner label="Creating…" /> : 'Create API key'}</button></div>}
        </section>
      </li>
      <li className={styles.step}>
        <span className={styles.number} aria-hidden="true">03</span>
        <section aria-labelledby="ask-claude-heading">
          <h2 id="ask-claude-heading">Ask Claude</h2>
          <p>In a chat, open <strong>+ → Connectors</strong> and enable <strong>Wareongo Context</strong>. Then ask normally.</p>
          <div className={styles.example}><span className={styles.label}>Your first question</span><p>“{effectiveScopes.includes('crm:read') ? 'Show my leads needing follow-up.' : effectiveScopes.includes('warehouses:read') ? 'Find warehouses in Bengaluru with at least 5 docks.' : 'What company guides can you read?'}”</p></div>
        </section>
      </li>
    </ol>
    <details className={styles.advanced}>
      <summary>Other AI tools & API details</summary>
      <div className={styles.advancedContent}>
        <p>Other MCP apps can use this connector URL once an administrator enables them.</p>
        <h2>Direct REST access</h2><p>For tools that can already send authenticated HTTP requests. These instructions are not needed for the Claude connector.</p>
        <label className={styles.fieldLabel} htmlFor="api-base">API base URL</label><div className={styles.copyRow}><input id="api-base" readOnly value={session.apiBaseUrl} /><button className="button button-secondary" onClick={() => void copy(session.apiBaseUrl, 'base')}>{copied === 'base' ? 'Copied API URL' : 'Copy API URL'}</button></div>
        <label className={styles.fieldLabel} htmlFor="rest-instructions">REST instructions</label><textarea id="rest-instructions" className={styles.prompt} value={prompt} readOnly spellCheck={false} />
        <div className={styles.advancedActions}><button className="button button-secondary" onClick={() => void copy(prompt, 'prompt')}>{copied === 'prompt' ? 'Copied instructions' : 'Copy instructions'}</button><a className="text-link" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">API reference<Icon name="external" size={14} /></a></div>
      </div>
    </details>
    </div>
    <aside className={styles.aside} aria-label="Connection access notes">
      <section className={styles.accessNotes} aria-labelledby="read-access-heading">
        <div className={styles.asideHeading}><Icon name="key" size={18} /><h2 id="read-access-heading">Your read access</h2></div>
        <p>Claude can retrieve these sources using your employee key.</p>
        <div className={styles.scopeList} role="list" aria-label="Your read access">{SCOPE_OPTIONS.filter(scope => effectiveScopes.includes(scope.value)).map(scope => <span className={styles.scope} role="listitem" key={scope.value}>{scope.label}</span>)}</div>
        {effectiveScopes.includes('crm:read') && <p>CRM records follow your permissions in Twenty.</p>}
        <div className={styles.boundary}><span className={styles.label}>Read-only by design</span><p>Research, compare and draft. Claude cannot change records, send messages or reserve a property through this connection.</p></div>
      </section>
      {effectiveScopes.includes('warehouses:read') && <div className={styles.verificationNote}><Icon name="file" size={18} /><p>Warehouse specifications can be approximate or incomplete. Ask Claude to flag details that need verification.</p></div>}
    </aside>
    </div>
    <span className="sr-only" role="status" aria-live="polite">{copied ? `${copied === 'base' ? 'API URL' : copied} copied to clipboard` : ''}</span>
    {confirmRotation && <ConfirmDialog title="Replace this API key?" confirmLabel="Replace key" destructive busy={busy} onCancel={() => setConfirmRotation(false)} onConfirm={() => void createKey()}><p>Connections using this key will stop working. Reconnect them with the new key.</p></ConfirmDialog>}
  </div>;
}
