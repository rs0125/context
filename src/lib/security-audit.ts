import { HttpError } from './errors';

type Action = 'login' | 'logout' | 'key_read' | 'key_rotate' | 'knowledge_save' | 'prompt_save';
type Details = { employeeId?: number; resourceId?: string; revision?: string; error?: unknown };

/** Deliberate field allowlist: no tokens, email addresses, bodies or raw errors. */
export function securityAudit(action: Action, outcome: 'success' | 'failure', details: Details = {}) {
  const entry: Record<string, unknown> = { event: 'context_security', action, outcome };
  if (Number.isSafeInteger(details.employeeId) && Number(details.employeeId) > 0) entry.employee_id = details.employeeId;
  if (typeof details.resourceId === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(details.resourceId)) entry.resource_id = details.resourceId;
  if (typeof details.revision === 'string' && /^[a-f0-9-]{36}$/.test(details.revision)) entry.revision = details.revision;
  if (outcome === 'failure') entry.code = details.error instanceof HttpError && /^[A-Z0-9_]{1,80}$/.test(details.error.code)
    ? details.error.code : 'INTERNAL_ERROR';
  console.info(JSON.stringify(entry));
}
