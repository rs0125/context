import { protectedResourceMetadata, oauthErrorResponse, oauthHeaders, oauthResponse } from '@/lib/mcp-oauth-protocol';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { return oauthResponse(protectedResourceMetadata(), 200, request); }
  catch (error) { return oauthErrorResponse(error, request); }
}
export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: oauthHeaders(request) }); }
  catch (error) { return oauthErrorResponse(error, request); }
}
