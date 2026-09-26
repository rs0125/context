import { handleMcpRequest } from '@/lib/mcp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

function handler(request: Request) { return handleMcpRequest(request); }
export { handler as GET, handler as POST, handler as OPTIONS,
  handler as DELETE, handler as PUT, handler as PATCH };
