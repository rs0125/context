'use client';

import { useEffect, useId, useRef } from 'react';
import { Icon } from './icons';

export function Brand({ compact = false }: { compact?: boolean }) {
  return <a href="/" className="brand" aria-label="Wareongo Context home"><span className="brand-mark" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 28 28" fill="none"><path d="m14 2 12 7-12 7L2 9 14 2Z" stroke="currentColor" /><path d="m2 14 12 7 12-7M2 19l12 7 12-7M14 16v10" stroke="currentColor" /></svg></span><strong>wareongo</strong>{!compact && <span className="brand-subtitle">Context</span>}</a>;
}

export function Notice({ children, tone = 'error', action }: { children: React.ReactNode; tone?: 'error' | 'info' | 'success'; action?: React.ReactNode }) {
  return <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}><Icon name={tone === 'success' ? 'check' : tone === 'error' ? 'alert' : 'shield'} size={18} /><div>{children}</div>{action && <div className="notice-action">{action}</div>}</div>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="loading-inline" role="status"><span className="spinner" aria-hidden="true" />{label}</span>;
}

export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel, busy = false, destructive = false }: {
  title: string; children: React.ReactNode; confirmLabel: string; onConfirm: () => void;
  onCancel: () => void; busy?: boolean; destructive?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialogRef} className="confirm-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <span className={`dialog-symbol ${destructive ? 'dialog-symbol-danger' : ''}`}><Icon name={destructive ? 'refresh' : 'file'} size={22} /></span>
    <h2 id={`${id}-title`}>{title}</h2><div id={`${id}-description`} className="dialog-description">{children}</div>
    <div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onCancel} disabled={busy} autoFocus>Cancel</button><button type="button" className={`button ${destructive ? 'button-danger' : 'button-primary'}`} onClick={onConfirm} disabled={busy} aria-label={busy ? 'Working…' : undefined}>{busy ? <Spinner label="Working…" /> : confirmLabel}</button></div>
  </dialog>;
}
