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

const permissionLabels: Record<string, string> = {
  'knowledge:read': 'Company guides',
  'warehouses:read': 'Warehouse listings',
  'crm:read': 'CRM records',
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
    <header className="consent-header"><Brand /><span className="header-classification">Connection request</span></header>
    <main className="consent-main" id="main-content">
      <section className="consent-card" aria-labelledby="consent-heading">
        <div className="consent-card-header"><p className="eyebrow"><Icon name="key" size={15} />Review access</p><h1 id="consent-heading">{details ? `${details.clientName} wants to read Wareongo context` : 'Connect to Wareongo'}</h1></div>
        {loading ? <div className="consent-state"><Spinner label="Checking the connection request…" /></div> : error || !details ? <div className="consent-state"><Notice>{error || 'This connection request is unavailable.'}</Notice><p>Start from your AI tool’s connector settings if this link has expired.</p><button className="button button-secondary" onClick={onRetry}><Icon name="refresh" size={16} />Check again</button></div> : <>
          <div className="consent-application"><dl><div><dt>Application website</dt><dd>{details.clientOrigin}</dd></div><div><dt>Return address</dt><dd>{details.redirectOrigin}</dd></div></dl>
            <details className="consent-details"><summary>Connection details</summary><dl><div><dt>Full return URL</dt><dd>{details.redirectUri}</dd></div><div><dt>Wareongo server</dt><dd>{details.resource}</dd></div></dl><p className="consent-client-note">The application supplies its name; Wareongo has not verified it. Check that you trust the website and return address.</p></details>
          </div>
          <div className="consent-permissions"><h2>Can read</h2><ul>{details.scopes.map(scope => <li key={scope}><span><Icon name="check" size={15} /></span><div><strong>{permissionLabels[scope] ?? scope}</strong></div></li>)}</ul><p className="consent-boundary">Only the data your API key allows. Nothing can be changed.</p></div>
          <form className="consent-form" method="post" action="/api/oauth/authorize" onSubmit={event => void connect(event)}>
            <label htmlFor="employee-api-key">Employee API key</label><input id="employee-api-key" name="apiKey" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={key} maxLength={128} onChange={event => setKey(event.target.value)} disabled={submitting || cancelling} required aria-describedby="employee-key-help" />
            <p id="employee-key-help">Copy your employee API key from the Connect Claude page and paste it here.</p>
            {formError && <Notice>{formError}</Notice>}
            <div className="consent-actions"><button className="button button-secondary" type="button" disabled={submitting || cancelling} aria-label={cancelling ? 'Cancelling…' : undefined} onClick={() => void cancel()}>{cancelling ? <Spinner label="Cancelling…" /> : 'Cancel'}</button><button className="button button-primary" type="submit" disabled={!key || submitting || cancelling} aria-label={submitting ? 'Connecting…' : undefined}>{submitting ? <Spinner label="Connecting…" /> : <>Connect<Icon name="arrow" size={17} /></>}</button></div>
            <p className="consent-key-note">Your key is submitted only to Wareongo Context and is not saved in this browser.</p>
          </form>
        </>}
      </section>
    </main>
    <footer className="consent-footer">Wareongo Context <span aria-hidden="true">/</span> Read-only access for AI tools</footer>
  </div>;
}
