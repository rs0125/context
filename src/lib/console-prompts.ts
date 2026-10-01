import { securityAudit } from './security-audit';
import type { PoolClient } from 'pg';
import { consoleErrorResponse, consoleJson, consoleWritesEnabled, getConsoleIdentity, readConsoleSession, requireConsoleOrigin } from './console-auth';
import { withConsoleWriteTransaction, withReadOnlyTransaction } from './db';
import { HttpError } from './errors';
import { readPrompts, savePrompt } from './prompts';

type Transaction = <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
type Dependencies = { readTransaction: Transaction; writeTransaction: Transaction; identity: typeof getConsoleIdentity; session: typeof readConsoleSession; origin: typeof requireConsoleOrigin };
const defaults: Dependencies = { readTransaction: withReadOnlyTransaction, writeTransaction: withConsoleWriteTransaction,
  identity: getConsoleIdentity, session: readConsoleSession, origin: requireConsoleOrigin };

async function readInput(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new HttpError(415, 'JSON_REQUIRED', 'Send the prompt as application/json.');
  // At most 20,000 characters, allowing JSON escaping on the wire.
  const maximum = 128000;
  const tooLarge = () => new HttpError(413, 'PROMPT_TOO_LARGE', 'The prompt request is too large.');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_JSON', 'A JSON prompt body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel().catch(() => undefined); throw tooLarge(); }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_JSON', 'The request must contain valid JSON.');
  } finally { reader.releaseLock(); }
}

export async function handleConsolePromptsRequest(request: Request, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  let employeeId: number | undefined;
  try {
    if (!['GET', 'PUT'].includes(request.method)) {
      const response = consoleJson({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or PUT.' } }, 405);
      response.headers.set('Allow', 'GET, PUT');
      return response;
    }
    const mutation = request.method === 'PUT';
    if (mutation) deps.origin(request);
    deps.session(request);
    const enabled = consoleWritesEnabled();
    let input: unknown;
    let inputError: unknown;
    if (mutation && enabled) { try { input = await readInput(request); } catch (error) { inputError = error; } }
    const transaction = mutation && enabled ? deps.writeTransaction : deps.readTransaction;
    const result = await transaction(async client => {
      const identity = await deps.identity(request, client);
      employeeId = identity.employeeId;
      if (identity.isAdmin !== true) throw new HttpError(403, 'ADMIN_REQUIRED', 'Administrator access is required to edit prompts.');
      if (!mutation) return { ...await readPrompts(client), writesEnabled: enabled };
      if (!enabled) throw new HttpError(503, 'CONSOLE_SETUP_REQUIRED', 'Prompt editing is not enabled yet.');
      if (inputError) throw inputError;
      return savePrompt(client, input, identity.email);
    });
    if ('prompt' in result) securityAudit('prompt_save', 'success', { employeeId, resourceId: result.prompt.id, revision: result.prompt.revision ?? undefined });
    return consoleJson(result);
  } catch (error) {
    if (request.method === 'PUT') securityAudit('prompt_save', 'failure', { employeeId, error });
    return consoleErrorResponse(error);
  }
}
