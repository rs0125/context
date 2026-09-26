'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConsoleApiError, consoleRequest, displayDate, errorMessage, makeSystemPrompt, mcpServerUrl } from './helpers';
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
  const mcpUrl = mcpServerUrl(session.apiBaseUrl);
  const effectiveScopes = key ? key.scopes.filter(scope => session.employee.scopes.includes(scope)) : session.employee.scopes;

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

  return <div className="access-workspace simple-setup">
    <div className="setup-intro">
      <h1>Connect Claude to Wareongo</h1>
      <p>Let Claude answer questions using company guides, warehouse details and your permitted CRM leads. It can read this information, but cannot change records.</p>
    </div>
    {!writesEnabled && <Notice tone="info">Connections are not available yet. An administrator needs to finish server setup.</Notice>}
    {copyError && <Notice>{copyError}</Notice>}
    <ol className="setup-steps" aria-label="Connect Claude in three steps">
      <li className="setup-step">
        <span className="setup-number" aria-hidden="true">1</span>
        <section aria-labelledby="add-connector-heading">
          <div className="setup-step-title"><h2 id="add-connector-heading">Add the connector in Claude</h2><a className="text-link" href="https://claude.ai" target="_blank" rel="noreferrer">Open Claude<Icon name="external" size={14} /></a></div>
          <p>Go to <strong>Customize → Connectors → + → Add custom connector</strong>.</p>
          <p>Name it <strong>Wareongo Context</strong> and paste this URL:</p>
          <label className="field-label" htmlFor="mcp-url">Connector URL</label>
          <div className="setup-copy-row"><input id="mcp-url" readOnly value={mcpUrl} /><button className="button button-primary" onClick={() => void copy(mcpUrl, 'url')}><Icon name={copied === 'url' ? 'check' : 'copy'} size={16} />{copied === 'url' ? 'Copied URL' : 'Copy URL'}</button></div>
          <p className="setup-hint">Leave OAuth Client ID and Client Secret blank, then click <strong>Add</strong>.</p>
        </section>
      </li>
      <li className="setup-step">
        <span className="setup-number" aria-hidden="true">2</span>
        <section aria-labelledby="connect-account-heading">
          <h2 id="connect-account-heading">Connect your account</h2>
          <p>Click <strong>Connect</strong> beside Wareongo Context in Claude. On the Wareongo page that opens, paste this key and click <strong>Connect</strong>.</p>
          <p className="setup-identity">This key gives access as <strong>{session.employee.email}</strong>.</p>
          <div className="setup-read-access"><span className="field-label">Your read access</span><div className="scope-list" role="list" aria-label="Your read access">{SCOPE_OPTIONS.filter(scope => effectiveScopes.includes(scope.value)).map(scope => <span className="scope-chip" role="listitem" key={scope.value}>{scope.label}</span>)}</div>
            {effectiveScopes.includes('crm:read') && <p className="setup-hint">CRM records follow your permissions in Twenty.</p>}
          </div>
          {error && <Notice action={<button className="text-button" onClick={() => void loadKey()}>Retry</button>}>{error}</Notice>}
          {loading ? <div className="setup-key-loading"><Spinner label="Loading your key…" /></div> : key ? <>
            <label className="field-label" htmlFor="personal-key">Employee API key</label>
            <div className="setup-copy-row"><div className="secret-field"><input id="personal-key" type={revealed ? 'text' : 'password'} value={key.token} readOnly autoComplete="off" spellCheck={false} /><button className="icon-button" onClick={() => setRevealed(!revealed)} aria-label={revealed ? 'Hide API key' : 'Reveal API key'} aria-pressed={revealed}><Icon name={revealed ? 'eye-off' : 'eye'} /></button></div><button className="button button-primary" disabled={busy} onClick={() => void copy(key.token, 'key')}><Icon name={copied === 'key' ? 'check' : 'copy'} size={16} />{copied === 'key' ? 'Copied key' : 'Copy key'}</button></div>
            <p className="setup-hint">This key goes on the Wareongo connection page, never in chat.</p>
            <details className="setup-key-settings"><summary>Key settings</summary><div><span>Expires {displayDate(key.expiresAt)}</span><button className="text-button" disabled={busy || !writesEnabled} onClick={() => setConfirmRotation(true)}>Replace key</button></div></details>
          </> : <div className="setup-key-empty"><p>Create your employee key to complete this step.</p><button className="button button-primary" disabled={!writesEnabled || busy || Boolean(error)} onClick={() => void createKey()}>{busy ? <Spinner label="Creating…" /> : 'Create API key'}</button></div>}
        </section>
      </li>
      <li className="setup-step">
        <span className="setup-number" aria-hidden="true">3</span>
        <section aria-labelledby="ask-claude-heading">
          <h2 id="ask-claude-heading">Ask Claude</h2>
          <p>In a chat, open <strong>+ → Connectors</strong> and enable <strong>Wareongo Context</strong>. Then ask normally.</p>
          <p className="setup-example">Try: “{effectiveScopes.includes('crm:read') ? 'Show my leads needing follow-up.' : effectiveScopes.includes('warehouses:read') ? 'Find warehouses in Bengaluru with at least 5 docks.' : 'What company guides can you read?'}”</p>
        </section>
      </li>
    </ol>
    <details className="setup-advanced">
      <summary>Other AI tools & API details</summary>
      <div className="setup-advanced-content">
        <p>Other MCP apps can use this connector URL once an administrator enables them.</p>
        <h2>Direct REST access</h2><p>For tools that can already send authenticated HTTP requests. These instructions are not needed for the Claude connector.</p>
        <label className="field-label" htmlFor="api-base">API base URL</label><div className="setup-copy-row"><input id="api-base" readOnly value={session.apiBaseUrl} /><button className="button button-secondary" onClick={() => void copy(session.apiBaseUrl, 'base')}>{copied === 'base' ? 'Copied API URL' : 'Copy API URL'}</button></div>
        <label className="field-label" htmlFor="rest-instructions">REST instructions</label><textarea id="rest-instructions" className="prompt-text" value={prompt} readOnly spellCheck={false} />
        <div className="setup-advanced-actions"><button className="button button-secondary" onClick={() => void copy(prompt, 'prompt')}>{copied === 'prompt' ? 'Copied instructions' : 'Copy instructions'}</button><a className="text-link" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">API reference<Icon name="external" size={14} /></a></div>
      </div>
    </details>
    <span className="sr-only" role="status" aria-live="polite">{copied ? `${copied === 'base' ? 'API URL' : copied} copied to clipboard` : ''}</span>
    {confirmRotation && <ConfirmDialog title="Replace this API key?" confirmLabel="Replace key" destructive busy={busy} onCancel={() => setConfirmRotation(false)} onConfirm={() => void createKey()}><p>Connections using this key will stop working. Reconnect them with the new key.</p></ConfirmDialog>}
  </div>;
}
