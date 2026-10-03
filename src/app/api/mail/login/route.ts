import { handleGoogleLogin } from '@/lib/console-google';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return handleGoogleLogin(request, { returnTo: '/mail' }); }
