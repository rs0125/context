'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ConsoleApiError, consoleRequest, displayDate, emptyDraft, errorMessage, importMarkdown, makeSlug, validateDraft } from './helpers';
import { Icon } from './icons';
import { ConfirmDialog, Notice, Spinner } from './ui';
import { SCOPE_OPTIONS, type KnowledgeMetadata, type KnowledgePage, type PageDraft } from './types';

const toDraft = (page: KnowledgePage): PageDraft => ({ id: page.id, title: page.title, summary: page.summary, status: page.status, scopes: page.scopes, body: page.body });
const serialize = (draft: PageDraft) => JSON.stringify(draft);

export function KnowledgeWorkspace({ writesEnabled, onSessionExpired, onDirtyChange, onBusyChange }: {
  writesEnabled: boolean; onSessionExpired: () => void; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [pages, setPages] = useState<KnowledgeMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<PageDraft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [saved, setSaved] = useState<KnowledgePage | null>(null);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState('');
  const [conflict, setConflict] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const fetchSequence = useRef(0);
  const dirty = Boolean(draft && serialize(draft) !== baseline);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const bytes = draft ? new TextEncoder().encode(draft.body).byteLength : 0;

  const loadPages = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setListError('');
    try { const result = await consoleRequest<{ pages: KnowledgeMetadata[] }>('/api/console/knowledge', { signal }); setPages(result.pages); }
    catch (cause) {
      if (signal?.aborted) return;
      if (cause instanceof ConsoleApiError && cause.status === 401) onSessionExpired();
      else setListError(errorMessage(cause));
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [onSessionExpired]);

  useEffect(() => { const controller = new AbortController(); void loadPages(controller.signal); return () => controller.abort(); }, [loadPages]);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(saving); return () => onBusyChange(false); }, [saving, onBusyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function runOrConfirm(action: () => void) { if (dirtyRef.current) setPendingAction(() => action); else action(); }
  function clearFeedback() { setError(''); setNotice(''); setSuccess(''); setConflict(false); }
  function startNew() {
    fetchSequence.current += 1; setFetching(false); clearFeedback();
    const fresh = emptyDraft(); setDraft(fresh); setBaseline(serialize(fresh)); setSaved(null);
  }
  async function openPage(id: string) {
    const request = ++fetchSequence.current; setFetching(true); clearFeedback();
    try {
      const result = await consoleRequest<{ page: KnowledgePage }>(`/api/console/knowledge/${encodeURIComponent(id)}`);
      if (request !== fetchSequence.current) return;
      const next = toDraft(result.page); setDraft(next); setBaseline(serialize(next)); setSaved(result.page);
    } catch (cause) {
      if (request !== fetchSequence.current) return;
      if (cause instanceof ConsoleApiError && cause.status === 401) onSessionExpired();
      else setError(errorMessage(cause));
    } finally { if (request === fetchSequence.current) setFetching(false); }
  }
  function updateDraft(change: Partial<PageDraft>) { setDraft(current => current ? { ...current, ...change } : current); setSuccess(''); }
  function changeTitle(title: string) {
    if (!draft) return;
    const canAutofillId = !saved && (!draft.id || draft.id === makeSlug(draft.title));
    updateDraft({ title, ...(canAutofillId ? { id: makeSlug(title) } : {}) });
  }
  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 100_000) throw new Error('Choose a Markdown file no larger than 100 KB.');
      const result = importMarkdown(await file.text(), file.name);
      runOrConfirm(() => { fetchSequence.current += 1; setFetching(false); clearFeedback(); setSaved(null); setBaseline(serialize(emptyDraft())); setDraft(result.draft); setNotice(result.notice); });
    } catch (cause) { setError(errorMessage(cause)); }
  }
  async function save() {
    if (!draft || !writesEnabled) return;
    const validation = validateDraft(draft); if (validation) { setError(validation); return; }
    setSaving(true); clearFeedback();
    try {
      const payload = { ...draft, title: draft.title.trim(), summary: draft.summary.trim(), ...(saved ? { revision: saved.revision } : {}) };
      const result = await consoleRequest<{ page: KnowledgePage }>(saved ? `/api/console/knowledge/${encodeURIComponent(saved.id)}` : '/api/console/knowledge', { method: saved ? 'PUT' : 'POST', body: payload });
      const next = toDraft(result.page); setDraft(next); setBaseline(serialize(next)); setSaved(result.page);
      setPages(current => [result.page, ...current.filter(page => page.id !== result.page.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setSuccess(result.page.status === 'reviewed' ? 'Page saved and available to agents with the required permissions.' : 'Draft saved. Agents cannot read it until it is marked Reviewed.');
    } catch (cause) {
      if (cause instanceof ConsoleApiError && cause.status === 401) onSessionExpired();
      else if (cause instanceof ConsoleApiError && cause.code === 'REVISION_CONFLICT') { setConflict(true); setError('This page changed since you opened it. Your edits are still here. Copy any changes you need, then load the latest version before saving again.'); }
      else setError(errorMessage(cause));
    } finally { setSaving(false); }
  }

  const filtered = pages.filter(page => `${page.title} ${page.id} ${page.summary}`.toLowerCase().includes(query.toLowerCase()));
  const publishing = draft?.status === 'reviewed' && saved?.status !== 'reviewed';

  return <div className="knowledge-workspace">
    <div className="page-heading"><div><p className="eyebrow">SHARED KNOWLEDGE</p><h1>Good context starts here.</h1><p>Create and review the Markdown pages your agents can read.</p></div><div className="heading-actions"><button className="button button-secondary" disabled={saving} onClick={() => uploadRef.current?.click()}><Icon name="upload" />Import .md</button><button className="button button-primary" disabled={saving} onClick={() => runOrConfirm(startNew)}><Icon name="plus" />New page</button></div></div>
    <input className="sr-only" type="file" accept=".md,text/markdown" ref={uploadRef} onChange={event => void upload(event)} aria-label="Import a Markdown file" tabIndex={-1} />
    {!writesEnabled && <Notice tone="info">Knowledge editing is waiting for workspace setup. You can prepare a page here, but saving will be available after an administrator enables it.</Notice>}
    <div className="knowledge-grid">
      <aside className="panel knowledge-library" aria-label="Knowledge pages"><div className="library-heading"><h2>Pages <span>{pages.length}</span></h2><button className="icon-button" aria-label="Refresh page list" disabled={loading || saving} onClick={() => void loadPages()}><Icon name="refresh" size={16} /></button></div><div className="search-field"><Icon name="search" size={17} /><input aria-label="Search knowledge pages" placeholder="Find a page…" value={query} onChange={event => setQuery(event.target.value)} /></div>
        {loading ? <div className="library-state"><Spinner label="Loading pages…" /></div> : listError ? <div className="library-state"><Notice action={<button className="text-button" onClick={() => void loadPages()}>Retry</button>}>{listError}</Notice></div> : filtered.length ? <div className="page-list">{filtered.map(page => <button key={page.id} className={`page-list-item ${saved?.id === page.id ? 'selected' : ''}`} aria-current={saved?.id === page.id ? 'true' : undefined} disabled={saving} onClick={() => { if (saved?.id !== page.id) runOrConfirm(() => void openPage(page.id)); }}><span className="page-item-top"><Icon name="file" size={17} /><span className={`publication-badge publication-${page.status}`}>{page.status === 'reviewed' ? 'Reviewed' : 'Draft'}</span></span><strong>{page.title}</strong><span className="page-item-summary">{page.summary}</span><span className="page-item-date">{displayDate(page.updatedAt)}</span></button>)}</div> : <div className="library-state empty-library"><Icon name="book" size={27} /><h3>{query ? 'No matching pages' : 'A clean starting point'}</h3><p>{query ? 'Try another title or keyword.' : 'Add your first page or import a Markdown file.'}</p></div>}
        <div className="library-footnote"><Icon name="shield" size={14} /><span>Only reviewed pages are shared with agents.</span></div>
      </aside>
      <section className="panel editor-panel" aria-label="Page editor" aria-busy={fetching || saving}>
        {fetching ? <div className="editor-loading"><Spinner label="Opening page…" /></div> : !draft ? <div className="editor-empty"><div className="editor-empty-art" aria-hidden="true"><div /><span><Icon name="file" size={38} /></span><div /></div><p className="eyebrow">MAKE KNOWLEDGE USEFUL</p><h2>A little context goes a long way.</h2><p>Select a page to edit, or start with a guide, process, or definition your team wants agents to understand.</p><button className="button button-primary" onClick={() => runOrConfirm(startNew)}><Icon name="plus" />Create a page</button>{error && <Notice>{error}</Notice>}</div> : <>
          <div className="editor-toolbar"><div><span className={`publication-badge publication-${draft.status}`}>{draft.status === 'reviewed' ? 'Reviewed' : 'Draft'}</span><span className="editor-save-status">{dirty ? <><span className="unsaved-dot" />Unsaved changes</> : saved ? `Saved ${displayDate(saved.updatedAt)}` : 'New page'}</span></div><button className="button button-primary" disabled={saving || !writesEnabled || (!dirty && Boolean(saved)) || conflict} onClick={() => void save()}>{saving ? <Spinner label="Saving…" /> : <><Icon name="check" size={17} />{publishing ? 'Save & publish' : draft.status === 'draft' ? 'Save draft' : 'Save changes'}</>}</button></div>
          <div className="editor-content">
            {error && <Notice action={conflict && saved ? <button className="text-button" onClick={() => runOrConfirm(() => void openPage(saved.id))}>Load latest</button> : undefined}>{error}</Notice>}
            {notice && <Notice tone="info">{notice}</Notice>}{success && <Notice tone="success">{success}</Notice>}
            <fieldset className="editor-fields" disabled={saving}><legend className="sr-only">Page content and metadata</legend>
              <div className="field"><label htmlFor="page-title">Page title</label><input id="page-title" className="title-input" placeholder="Give this page a clear title" value={draft.title} maxLength={200} onChange={event => changeTitle(event.target.value)} /></div>
              <div className="field"><label htmlFor="page-id">Page ID <span>Used in the API path</span></label><div className={`slug-field ${saved ? 'is-disabled' : ''}`}><span>/wiki/pages/</span><input id="page-id" value={draft.id} maxLength={100} placeholder="your-page-title" disabled={Boolean(saved)} onChange={event => updateDraft({ id: event.target.value })} spellCheck={false} /></div></div>
              <div className="field"><label htmlFor="page-summary">Summary <span>Help an agent find the right page</span></label><textarea id="page-summary" rows={2} value={draft.summary} maxLength={500} placeholder="What should someone know before opening this page?" onChange={event => updateDraft({ summary: event.target.value })} /></div>
              <div className="metadata-grid"><div className="field"><label htmlFor="page-status">Publication status</label><select id="page-status" aria-describedby="publication-reminder" value={draft.status} onChange={event => updateDraft({ status: event.target.value as PageDraft['status'] })}><option value="draft">Draft — admins only</option><option value="reviewed">Reviewed — available to agents</option></select><p className="field-hint">Mark as reviewed only after checking the content.</p></div><fieldset className="scope-picker"><legend>Required reader permissions</legend>{SCOPE_OPTIONS.map(scope => <label key={scope.value}><input type="checkbox" checked={draft.scopes.includes(scope.value)} disabled={scope.value === 'knowledge:read'} onChange={event => updateDraft({ scopes: event.target.checked ? [...draft.scopes, scope.value] : draft.scopes.filter(value => value !== scope.value) })} /><span>{scope.label}</span>{scope.value === 'knowledge:read' && <small>Required</small>}</label>)}<p className="field-hint">Readers must have every selected permission.</p></fieldset></div>
              <div className="publication-reminder" id="publication-reminder"><Icon name="shield" size={16} /><p>Reviewed pages are shared as written with employees who have the selected permissions. Remove phone numbers, contact details, and confidential notes before publishing.</p></div>
              <div className="field markdown-field"><div className="markdown-label"><label htmlFor="page-body">Markdown content</label><span className={bytes > 100_000 ? 'over-limit' : ''}>{(bytes / 1000).toFixed(1)} / 100 KB</span></div><textarea id="page-body" className="markdown-editor" value={draft.body} onChange={event => updateDraft({ body: event.target.value })} placeholder={'# Start with what matters\n\nWrite the context an agent needs to give a useful answer.\n\n## Useful details\n\n- Be specific\n- Explain terms\n- Include what still needs verification'} spellCheck={false} /><div className="markdown-footer"><span>Plain Markdown · no rendered scripts</span><span>Stored privately · shared by permission</span></div></div>
            </fieldset>
          </div>
        </>}
      </section>
    </div>
    {pendingAction && <ConfirmDialog title="Discard unsaved changes?" confirmLabel="Discard changes" destructive onCancel={() => setPendingAction(null)} onConfirm={() => { const action = pendingAction; setPendingAction(null); action(); }}><p>Your edits have not been saved. Continuing will replace them.</p></ConfirmDialog>}
  </div>;
}
