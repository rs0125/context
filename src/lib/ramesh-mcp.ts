/** Dedicated server-to-server entry point. Claude's /mcp continues using employee OAuth exclusively. */
import { randomUUID } from 'node:crypto';
import { handleMcpRequest, type McpDependencies } from './mcp';
import { authenticateRameshRequest, revalidateRameshRequest, type RameshAuthDependencies } from './ramesh-auth';
import { HttpError } from './errors';

export async function handleRameshMcpRequest(request: Request, overrides: {
  auth?: Partial<RameshAuthDependencies>; read?: McpDependencies['read']; prompts?: McpDependencies['prompts'];
  audit?: (entry: Record<string, unknown>) => void;
} = {}) {
  // No browser CORS, idle streams or alternate methods on the internal profile.
  if (request.headers.has('origin')) return Response.json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'This endpoint accepts server requests only.' } }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } });
  if (request.method !== 'POST') return Response.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use HTTP POST.' } }, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'private, no-store' } });
  const requestId = randomUUID(); let employeeId: number | undefined, keyId: string | undefined;
  const response = await handleMcpRequest(request, {
    ...overrides,
    platform: 'whatsapp',
    authenticationChallenge: 'Ramesh realm="wareongo-context"',
    authenticate: async original => {
      if (original.headers.has('origin')) throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'This endpoint accepts server requests only.');
      const key = await authenticateRameshRequest(original, overrides.auth);
      employeeId = key.employeeId; keyId = key.id; return key;
    },
    revalidateKey: revalidateRameshRequest,
  });
  response.headers.set('X-Request-Id', requestId);
  try { (overrides.audit ?? (entry => console.info(JSON.stringify(entry))))({ event: 'ramesh_mcp_request', actor: 'ramesh', requestId, employeeId, keyId, status: response.status }); }
  catch { /* Audit sinks cannot change an authorization decision. */ }
  return response;
}
