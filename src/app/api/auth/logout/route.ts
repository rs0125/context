import { consoleCookie, consoleErrorResponse, consoleJson, requireConsoleOrigin } from '@/lib/console-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    requireConsoleOrigin(request);
    const response = consoleJson({ signedOut: true });
    response.headers.append('Set-Cookie', consoleCookie('session', '', 0));
    response.headers.append('Set-Cookie', consoleCookie('oauth', '', 0));
    return response;
  } catch (error) { return consoleErrorResponse(error); }
}
