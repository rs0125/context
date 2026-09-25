import { handleMcpOAuthRequest } from '@/lib/mcp-oauth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return handleMcpOAuthRequest(request, 'authorize'); }
export async function POST(request: Request) { return handleMcpOAuthRequest(request, 'authorize'); }
export async function OPTIONS(request: Request) { return handleMcpOAuthRequest(request, 'authorize'); }
