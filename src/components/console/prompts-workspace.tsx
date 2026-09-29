'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PromptCollection, PromptDocument, PromptId } from '@/lib/prompt-definitions';
import { ConsoleApiError, consoleAccessEnded, consoleRequest, displayDate, errorMessage } from './helpers';
import { Icon } from './icons';
import { ConfirmDialog, Notice, Spinner } from './ui';
import styles from './prompts-workspace.module.css';

export function PromptsWorkspace({ writesEnabled, onSessionExpired, onDirtyChange, onBusyChange, onSaved }: {
  writesEnabled: boolean; onSessionExpired: () => void; onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void; onSaved: (prompt: PromptDocument) => void;
}) {
  const [collection, setCollection] = useState<PromptCollection | null>(null);
  const [selected, setSelected] = useState<PromptId>('mcp');
  const [draft, setDraft] = useState('');
  const [useDefault, setUseDefault] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [conflict, setConflict] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const sequence = useRef(0);
  const current = collection?.prompts.find(prompt => prompt.id === selected);
  const dirty = Boolean(current && (draft !== current.body || (useDefault && current.customized)));
  const busy = loading || saving;
  const canSave = writesEnabled && collection?.writesEnabled && collection.storageReady;

  const load = useCallback(async (id: PromptId, signal?: AbortSignal) => {
    const request = ++sequence.current;
    setLoading(true); setError(''); setSuccess('');
    try {
      const result = await consoleRequest<PromptCollection>('/api/console/prompts', { signal });
      if (signal?.aborted || request !== sequence.current) return;
      const prompt = result.prompts.find(item => item.id === id) ?? result.prompts[0];
      setCollection(result); setSelected(prompt.id); setDraft(prompt.body); setUseDefault(false); setConflict(false);
    } catch (cause) {
      if (signal?.aborted || request !== sequence.current) return;
      if (consoleAccessEnded(cause)) onSessionExpired(); else setError(errorMessage(cause));
    } finally { if (!signal?.aborted && request === sequence.current) setLoading(false); }
  }, [onSessionExpired]);

  useEffect(() => {
    const controller = new AbortController(); void load('mcp', controller.signal);
    return () => { controller.abort(); sequence.current += 1; };
  }, [load]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { onDirtyChange(false); onBusyChange(false); }, [onDirtyChange, onBusyChange]);
  useEffect(() => {
    if (!dirty && !saving) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, saving]);

  function guard(action: () => void) { if (busy) return; if (dirty) setPendingAction(() => action); else action(); }
  function select(prompt: PromptDocument) {
    setSelected(prompt.id); setDraft(prompt.body); setUseDefault(false); setConflict(false); setError(''); setSuccess('');
  }
  async function save() {
    if (!current || !dirty || !canSave || saving || conflict) return;
    setSaving(true); setError(''); setSuccess('');
    const request = sequence.current;
    try {
      const { prompt } = await consoleRequest<{ prompt: PromptDocument }>('/api/console/prompts', { method: 'PUT',
        body: { id: current.id, body: useDefault || draft === current.defaultBody ? null : draft, revision: current.revision } });
      if (request !== sequence.current) return;
      setCollection(value => value && { ...value, prompts: value.prompts.map(item => item.id === prompt.id ? prompt : item) });
      setDraft(prompt.body); setUseDefault(false);
      setSuccess(prompt.id === 'rest' ? 'Saved. The updated instructions are available to copy from the connection page.'
        : 'Saved. Reconnect existing AI connections to refresh their instructions and tool descriptions.');
      onSaved(prompt);
    } catch (cause) {
      if (request !== sequence.current) return;
      if (consoleAccessEnded(cause)) onSessionExpired();
      else { setConflict(cause instanceof ConsoleApiError && cause.code === 'REVISION_CONFLICT'); setError(errorMessage(cause)); }
    } finally { if (request === sequence.current) setSaving(false); }
  }

  const filtered = collection?.prompts.filter(prompt => `${prompt.title} ${prompt.id} ${prompt.group}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const groups = [...new Set(filtered.map(prompt => prompt.group))];
  return <div className={styles.workspace}>
    <div className="page-heading"><div><p className="eyebrow">Agent configuration</p><h1>Prompts</h1><p>Edit the instructions your team’s AI receives. Saved changes apply across the workspace.</p></div></div>
    {collection && !canSave && <Notice tone="info">Prompt editing is waiting for workspace setup. You can review the current prompts here; saving becomes available when prompt storage and console writes are enabled.</Notice>}
    {error && <Notice action={<button className="text-button" disabled={busy} onClick={() => guard(() => void load(selected))}>{conflict ? 'Load latest' : 'Retry loading'}</button>}>{error}</Notice>}
    {success && <Notice tone="success">{success}</Notice>}
    <div className={styles.grid}>
      <aside className={`panel ${styles.library}`} aria-label="Prompt library">
        <div className={styles.libraryHeading}><h2>Instructions <span>{collection?.prompts.length ?? 0}</span></h2><button className="icon-button" aria-label="Refresh prompts" disabled={busy} onClick={() => guard(() => void load(selected))}><Icon name="refresh" size={16} /></button></div>
        <div className={`search-field ${styles.search}`}><Icon name="search" size={17} /><input aria-label="Search prompts" placeholder="Find a prompt…" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <div className={styles.list}>{loading ? <div className={styles.empty}><Spinner label="Loading prompts…" /></div> : groups.length ? groups.map(group => <div key={group} className={styles.group}>
          <h3>{group}</h3>{filtered.filter(prompt => prompt.group === group).map(prompt => <button key={prompt.id} className={`${styles.item} ${selected === prompt.id ? styles.selected : ''}`} aria-current={selected === prompt.id ? 'true' : undefined} disabled={busy} onClick={() => { if (prompt.id !== selected) guard(() => select(prompt)); }}>
            <span>{prompt.title}</span><small>{prompt.customized ? 'Custom' : 'Default'}</small>
          </button>)}
        </div>) : <p className={styles.empty}>{collection ? 'No matching prompts.' : 'Prompts could not be loaded.'}</p>}</div>
      </aside>
      <section className={`panel ${styles.editor}`} aria-label="Prompt editor" aria-busy={busy}>
        {!current ? <div className={styles.empty}>{loading ? <Spinner label="Opening editor…" /> : 'Select a prompt to edit.'}</div> : <>
          <div className={styles.toolbar}><div><span className={styles.status}>{dirty ? 'Unsaved changes' : current.customized ? 'Custom prompt' : 'Using default'}</span><h2>{current.title}</h2></div>
            <button className="button button-primary" disabled={busy || !dirty || !canSave || conflict || !draft.trim() || draft.length > current.maxLength} onClick={() => void save()}>{saving ? <Spinner label="Saving…" /> : 'Save prompt'}</button>
          </div>
          <div className={styles.content}>
            <p className={styles.help} id="prompt-help">{current.help}</p>
            <div className={styles.label}><label htmlFor="prompt-body">Prompt text</label><span id="prompt-size">{draft.length.toLocaleString()} / {current.maxLength.toLocaleString()} characters</span></div>
            <textarea id="prompt-body" aria-describedby="prompt-help prompt-size" value={draft} maxLength={current.maxLength} disabled={busy} spellCheck={false} onChange={event => { setDraft(event.target.value); setUseDefault(false); setSuccess(''); }} />
            <div className={styles.actions}><button className="button button-secondary" disabled={busy || (!current.customized && draft === current.defaultBody)} onClick={() => { setDraft(current.defaultBody); setUseDefault(true); setSuccess(''); }}>Restore default</button>
              {dirty && <button className="button button-quiet" disabled={busy} onClick={() => guard(() => select(current))}>Discard edits</button>}
              <span>{useDefault && dirty ? 'Save to apply the default.' : current.updatedAt ? `Saved ${displayDate(current.updatedAt, true)}${current.updatedBy ? ` by ${current.updatedBy}` : ''}` : 'Built-in default'}</span>
            </div>
            <details className={styles.defaultPreview}><summary>View built-in default</summary><pre>{current.defaultBody}</pre></details>
            <p className={styles.footnote}>{current.id === 'rest' ? 'Previously copied prompts keep their original text. Copy the updated instructions to use them in an existing setup.' : 'Existing AI connections may cache these instructions. Reconnect after saving to load the latest version.'}</p>
          </div>
        </>}
      </section>
    </div>
    {pendingAction && <ConfirmDialog title="Discard unsaved changes?" confirmLabel="Discard changes" destructive onCancel={() => setPendingAction(null)} onConfirm={() => { const action = pendingAction; setPendingAction(null); action(); }}><p>Your prompt edits have not been saved. Continuing will replace them.</p></ConfirmDialog>}
  </div>;
}
