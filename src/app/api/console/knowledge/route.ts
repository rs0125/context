import { handleConsoleKnowledgeRequest } from '@/lib/console-knowledge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleConsoleKnowledgeRequest(request);
}

export async function POST(request: Request) {
  return handleConsoleKnowledgeRequest(request);
}
