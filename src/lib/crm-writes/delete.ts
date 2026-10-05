/** Explicit deletion of an employee's agent-created opportunity, independent of undo history. */
import { z } from 'zod';
import { HttpError } from '../errors';
import { changeConfiguration } from './change-access';
import { rfqInputSchema } from './rfq';
import { rfqVersionSchema } from './changes';

export const rfqDeleteInputSchema = z.object({
  operation_id: rfqInputSchema.shape.operation_id,
  id: z.string().uuid().describe('Opportunity ID created by Ramesh for the current employee and still assigned to them.'),
  expected_updated_at: rfqVersionSchema,
  raw_text: rfqInputSchema.shape.raw_text.describe('Complete current user request to delete this specific opportunity.'),
}).strict();
export const rfqDeleteOutputSchema = z.object({
  operation_id: z.string().uuid(),
  outcome: z.enum(['deleted', 'replayed', 'not_dispatched', 'rejected', 'outcome_unknown']),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/), message: z.string().min(1).max(2000),
  data: z.object({ id: z.string().uuid(), name: z.string().max(500), url: z.string().url(),
    deletion_kind: z.literal('trash'), undo_available: z.literal(false) }).strict().optional(),
}).strict();
export type RfqDeleteResult = z.infer<typeof rfqDeleteOutputSchema>;

export function rfqDeleteConfiguration(env: Partial<NodeJS.ProcessEnv> = process.env) {
  const config = changeConfiguration(env);
  if (env.CONTEXT_CRM_DELETES_ENABLED !== 'true') throw new HttpError(503, 'CRM_DELETES_DISABLED', 'CRM deletion is not enabled.');
  return config;
}
export function rfqDeleteAvailability(env: Partial<NodeJS.ProcessEnv> = process.env) {
  try { rfqDeleteConfiguration(env); return { available: true }; }
  catch { return { available: false }; }
}
