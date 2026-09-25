import { consoleErrorResponse, consoleJson, consoleOrigin, consoleWritesEnabled, getConsoleIdentity, readConsoleSession } from '@/lib/console-auth';
import { withReadOnlyTransaction } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    readConsoleSession(request);
    const identity = await withReadOnlyTransaction(client => getConsoleIdentity(request, client));
    return consoleJson({ employee: { email: identity.email, name: identity.name, isAdmin: identity.isAdmin, scopes: identity.scopes },
      apiBaseUrl: `${consoleOrigin()}/api/v1`, capabilities: { writesEnabled: consoleWritesEnabled() } });
  } catch (error) { return consoleErrorResponse(error); }
}
