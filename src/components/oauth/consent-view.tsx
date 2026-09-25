'use client';

import { useState, type FormEvent } from 'react';
import { Icon } from '@/components/console/icons';
import { Brand, Notice, Spinner } from '@/components/console/ui';

export type ConsentDetails = {
  clientName: string;
  clientOrigin: string;
  redirectOrigin: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
};

const permissionLabels: Record<string, { title: string; description: string }> = {
  'knowledge:read': { title: 'Company knowledge', description: 'Read reviewed pages available to your employee identity.' },
  'warehouses:read': { title: 'Warehouse context', description: 'Read permitted warehouse specifications and search filters.' },
  'crm:read': { title: 'CRM context', description: 'Read opportunities and briefings within your current CRM access.' },
};

export function ConsentView({ details, loading, error, onRetry, onConnect, onCancel }: {
  details: ConsentDetails | null; loading: boolean; error: string; onRetry: () => void;
  onConnect: (key: string) => Promise<void>; onCancel: () => Promise<void>;
}) {
  const [key, setKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [formError, setFormError] = useState('');

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!details || !key || submitting || cancelling) return;
    const submittedKey = key;
    setSubmitting(true); setFormError(''); setKey('');
    try { await onConnect(submittedKey); }
    catch (cause) { setFormError(cause instanceof Error ? cause.message : 'The connection could not be authorized. Please try again.'); }
    finally { setKey(''); setSubmitting(false); }
  }

  async function cancel() {
    setKey(''); setCancelling(true); setFormError('');
    try { await onCancel(); }
    catch (cause) { setFormError(cause instanceof Error ? cause.message : 'The request could not be cancelled. Close this page to leave without connecting.'); }
    finally { setCancelling(false); }
  }

  return <div className="consent-shell">
    <header className="consent-header"><Brand /><span><Icon name="shield" size={15} />Secure authorization</span></header>
    <main className="consent-main" id="main-content">
      <section className="consent-card" aria-labelledby="consent-heading">
        <div className="consent-card-header"><span className="consent-symbol"><Icon name="code" size={26} /></span><p className="eyebrow">YOUR CONTEXT. YOUR PERMISSION.</p><h1 id="consent-heading">Approve a connection.</h1><p>Let an application read the Wareongo context your employee key can access.</p></div>
        {loading ? <div className="consent-state"><Spinner label="Checking the connection request…" /></div> : error || !details ? <div className="consent-state"><Notice>{error || 'This connection request is unavailable.'}</Notice><p>Start from your AI tool’s connector settings if this link has expired.</p><button className="button button-secondary" onClick={onRetry}><Icon name="refresh" size={16} />Check again</button></div> : <>
          <div className="consent-application"><p className="field-label">REQUESTING APPLICATION</p><h2>{details.clientName}</h2><dl><div><dt>Application origin</dt><dd>{details.clientOrigin}</dd></div><div><dt>Return origin</dt><dd>{details.redirectOrigin}</dd></div><div><dt>Redirect URI</dt><dd>{details.redirectUri}</dd></div><div><dt>Context server</dt><dd>{details.resource}</dd></div></dl><p className="consent-client-note">The application provides its name. Check the displayed origins and full redirect URI before connecting.</p></div>
          <div className="consent-permissions"><h2>Requested read permissions</h2><ul>{details.scopes.map(scope => { const permission = permissionLabels[scope]; return <li key={scope}><span><Icon name="check" size={15} /></span><div><strong>{permission?.title ?? scope}</strong><p>{permission?.description ?? 'Only permissions supported by your employee key can be granted.'}</p></div></li>; })}</ul><p className="consent-boundary"><Icon name="shield" size={15} />This connection cannot edit business records or manage the knowledge library.</p></div>
          <form className="consent-form" method="post" action="/api/oauth/authorize" onSubmit={event => void connect(event)}>
            <label htmlFor="employee-api-key">Employee API key</label><input id="employee-api-key" name="apiKey" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={key} maxLength={128} onChange={event => setKey(event.target.value)} disabled={submitting || cancelling} required aria-describedby="employee-key-help" />
            <p id="employee-key-help">Use your own employee key starting with <code>wog_ctx_</code>. The console administrator password will not work here. Keep this key out of chat.</p>
            {formError && <Notice>{formError}</Notice>}
            <div className="consent-actions"><button className="button button-secondary" type="button" disabled={submitting || cancelling} onClick={() => void cancel()}>{cancelling ? <Spinner label="Cancelling…" /> : 'Cancel'}</button><button className="button button-primary" type="submit" disabled={!key || submitting || cancelling}>{submitting ? <Spinner label="Connecting…" /> : <>Connect<Icon name="arrow" size={17} /></>}</button></div>
            <p className="consent-key-note">Your key is submitted only to Wareongo Context and is not saved in this browser.</p>
          </form>
        </>}
      </section>
    </main>
    <footer className="consent-footer">Wareongo Context <span>·</span> Read-only access, bound to your identity.</footer>
  </div>;
}
