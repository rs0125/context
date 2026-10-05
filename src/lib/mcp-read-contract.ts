/** Server-owned discovery and request binding. Metadata never replaces live API authorization. */
import { createHash } from 'node:crypto';
import type { Scope } from './auth';
import { HttpError } from './errors';
import { READ_CONTRACTS } from './tools/catalog';
export type { ReadToolName } from './tools/catalog';
import type { ReadToolName } from './tools/catalog';

export const MCP_READ_CONTRACT_KEY = 'wareongo/context-read-v1';
export const MCP_READ_CONTRACTS = READ_CONTRACTS;

export function readToolMetadata(name: ReadToolName) {
  return { [MCP_READ_CONTRACT_KEY]: structuredClone(MCP_READ_CONTRACTS[name]) };
}

/** Matches the read client's canonical JSON: ordinal object keys, unchanged array order. */
export function argumentsSha256(args: Record<string, unknown>): string {
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 40) throw new HttpError(400, 'INVALID_ARGUMENTS', 'MCP arguments are too deeply nested.');
    if (Array.isArray(value)) return value.map(child => visit(child, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, visit(child, depth + 1)]),
    );
    return value;
  };
  return createHash('sha256').update(JSON.stringify(visit(args, 0))).digest('hex');
}

export type McpRequestBinding = Readonly<{ toolName: string; argumentsSha256: string }>;

/** Capture before the SDK applies tool schemas, trims strings or fills defaults. */
export function requestReadBinding(body: Buffer): McpRequestBinding | undefined {
  let rpc: unknown;
  try { rpc = JSON.parse(body.toString('utf8')); }
  catch { return undefined; } // The MCP transport retains its normal parse-error response.
  if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc)) return undefined;
  const message = rpc as { method?: unknown; params?: unknown };
  if (message.method !== 'tools/call' || !message.params || typeof message.params !== 'object' || Array.isArray(message.params)) return undefined;
  const params = message.params as { name?: unknown; arguments?: unknown };
  const args = params.arguments === undefined ? {} : params.arguments;
  if (typeof params.name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  return Object.freeze({ toolName: params.name, argumentsSha256: argumentsSha256(args as Record<string, unknown>) });
}
