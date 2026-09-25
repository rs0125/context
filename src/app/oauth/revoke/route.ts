import { handleMcpOAuthRequest } from '@/lib/mcp-oauth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return handleMcpOAuthRequest(request, 'revoke'); }
export async function OPTIONS(request: Request) { return handleMcpOAuthRequest(request, 'revoke'); }
