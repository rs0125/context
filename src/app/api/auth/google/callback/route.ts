import { consoleCookie, consoleErrorResponse, consoleOrigin, createConsoleSession, resolveConsoleEmployee, SESSION_SECONDS } from '@/lib/console-auth';
import { finishGoogleSignIn } from '@/lib/console-oauth';
import { withReadOnlyTransaction } from '@/lib/db';
import { HttpError } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export async function GET(request: Request) {
  try {
    // HTTPS exchange and signing-key lookup complete before opening a database
    // transaction. Google tokens are never stored or returned to the browser.
    const google = await finishGoogleSignIn(request);
    const identity = await withReadOnlyTransaction(client => resolveConsoleEmployee(client, google.email));
    const headers = new Headers({ Location: `${consoleOrigin()}/`, 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', consoleCookie('oauth', '', 0));
    headers.append('Set-Cookie', consoleCookie('session', createConsoleSession(identity, google.sub), SESSION_SECONDS));
    return new Response(null, { status: 303, headers });
  } catch (error) {
    try {
      const code = error instanceof HttpError && ['CONSOLE_ACCESS_DENIED', 'CONSOLE_CONFIGURATION', 'GOOGLE_UNAVAILABLE'].includes(error.code)
        ? error.code : 'GOOGLE_SIGN_IN_DENIED';
      return new Response(null, { status: 303, headers: { Location: `${consoleOrigin()}/?auth_error=${code}`,
        'Set-Cookie': consoleCookie('oauth', '', 0), 'Cache-Control': 'no-store' } });
    } catch { return consoleErrorResponse(error); }
  }
}
