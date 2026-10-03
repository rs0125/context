import { handleGmailConnection, handleGmailDisconnect } from '@/lib/gmail-oauth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export async function GET(request: Request) { return handleGmailConnection(request); }
export async function POST(request: Request) { return handleGmailDisconnect(request); }
