import { handleApiRequest } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

type Context = { params: Promise<{ path?: string[] }> };
async function handler(request: Request, context: Context) {
  const { path = [] } = await context.params;
  return handleApiRequest(request, path);
}
export { handler as GET, handler as HEAD, handler as OPTIONS, handler as POST,
  handler as PUT, handler as PATCH, handler as DELETE };
