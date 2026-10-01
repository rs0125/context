import { consoleCookie, consoleErrorResponse, consoleJson, readConsoleSession, requireConsoleOrigin } from '@/lib/console-auth';
import { revokeConsoleSession } from '@/lib/console-sessions';
import { withSessionWriteTransaction } from '@/lib/db';
import { HttpError } from '@/lib/errors';
import { securityAudit } from '@/lib/security-audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let employeeId: number | undefined;
  try {
    requireConsoleOrigin(request);
    let session;
    try { session = readConsoleSession(request); }
    catch (error) { if (!(error instanceof HttpError) || error.status !== 401) throw error; }
    if (session) {
      employeeId = session.employeeId;
      // Revoke even if the employee was removed. A failed write must not claim
      // logout succeeded or clear the cookie needed to retry revocation.
      await withSessionWriteTransaction(client => revokeConsoleSession(client, session));
    }
    const response = consoleJson({ signedOut: true });
    response.headers.append('Set-Cookie', consoleCookie('session', '', 0));
    response.headers.append('Set-Cookie', consoleCookie('oauth', '', 0));
    securityAudit('logout', 'success', { employeeId });
    return response;
  } catch (error) { securityAudit('logout', 'failure', { employeeId, error }); return consoleErrorResponse(error); }
}
