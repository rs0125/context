import { consoleErrorResponse, consoleJson, consoleOrigin, consoleWritesEnabled, getConsoleIdentity, readConsoleSession } from '@/lib/console-auth';
import { withReadOnlyTransaction } from '@/lib/db';
import { readPrompts } from '@/lib/prompts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    readConsoleSession(request);
    const { identity, restPromptTemplate } = await withReadOnlyTransaction(async client => {
      const identity = await getConsoleIdentity(request, client);
      const { prompts } = await readPrompts(client);
      return { identity, restPromptTemplate: prompts.find(prompt => prompt.id === 'rest')!.body };
    });
    return consoleJson({ employee: { email: identity.email, name: identity.name, isAdmin: identity.isAdmin, isAnalyst: identity.isAnalyst, scopes: identity.scopes },
      apiBaseUrl: `${consoleOrigin()}/api/v1`, restPromptTemplate, capabilities: { writesEnabled: consoleWritesEnabled() } });
  } catch (error) { return consoleErrorResponse(error); }
}
