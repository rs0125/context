import { handleConsoleKnowledgeRequest } from '@/lib/console-knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return handleConsoleKnowledgeRequest(request, (await context.params).id);
}

export async function PUT(request: Request, context: Context) {
  return handleConsoleKnowledgeRequest(request, (await context.params).id);
}
