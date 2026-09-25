import { consoleErrorResponse } from '@/lib/console-auth';
import { beginGoogleSignIn } from '@/lib/console-oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const result = beginGoogleSignIn();
    return new Response(null, { status: 303, headers: { Location: result.url, 'Set-Cookie': result.cookie, 'Cache-Control': 'no-store' } });
  } catch (error) { return consoleErrorResponse(error); }
}
