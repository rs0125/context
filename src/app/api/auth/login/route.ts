import { handlePasswordLogin } from '@/lib/console-password';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handlePasswordLogin(request);
}
