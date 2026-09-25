import { consoleErrorResponse, consoleJson, getConsoleIdentity, readConsoleSession, requireConsoleOrigin, requireConsoleWrites } from '@/lib/console-auth';
import { getOwnConsoleKey, rotateOwnConsoleKey } from '@/lib/console-keys';
import { withConsoleWriteTransaction, withReadOnlyTransaction } from '@/lib/db';
import { HttpError } from '@/lib/errors';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    readConsoleSession(request); requireConsoleWrites();
    if (new URL(request.url).search) throw new HttpError(400, 'INVALID_QUERY', 'Key lookup does not accept query parameters.');
    const key = await withReadOnlyTransaction(async client => getOwnConsoleKey(client, await getConsoleIdentity(request, client)));
    return consoleJson({ key });
  } catch (error) { return consoleErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    requireConsoleOrigin(request); readConsoleSession(request); requireConsoleWrites();
    if (new URL(request.url).search) throw new HttpError(400, 'INVALID_QUERY', 'Key rotation does not accept query parameters.');
    // No caller-controlled identity or scopes: every key belongs to the current
    // live roster identity and is limited to that employee's current access.
    if (Number(request.headers.get('content-length') ?? 0) > 2) throw new HttpError(400, 'INVALID_BODY', 'Key rotation does not accept input.');
    const chunks: Uint8Array[] = []; let length = 0;
    const reader = request.body?.getReader();
    if (reader) {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 2) { await reader.cancel(); throw new HttpError(400, 'INVALID_BODY', 'Key rotation does not accept input.'); }
        chunks.push(chunk.value);
      }
    }
    const body = Buffer.concat(chunks).toString('utf8');
    if (body !== '' && body !== '{}') throw new HttpError(400, 'INVALID_BODY', 'Key rotation does not accept input.');
    const key = await withConsoleWriteTransaction(async client => {
      const identity = await getConsoleIdentity(request, client);
      rateLimit(`console-key-${identity.employeeId}`, Date.now(), 6);
      return rotateOwnConsoleKey(client, identity);
    });
    return consoleJson({ key });
  } catch (error) { return consoleErrorResponse(error); }
}
