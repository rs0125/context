import { consoleJson } from '@/lib/console-auth';
import { handleGoogleLogin } from '@/lib/console-google';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) { return handleGoogleLogin(request); }

// Password credentials are deliberately never parsed or accepted.
export async function POST() {
  const response = consoleJson({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use Google sign-in to access the console.' } }, 405);
  response.headers.set('Allow', 'GET');
  return response;
}
