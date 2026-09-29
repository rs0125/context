import { handleConsolePromptsRequest } from '@/lib/console-prompts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) { return handleConsolePromptsRequest(request); }
export async function PUT(request: Request) { return handleConsolePromptsRequest(request); }
