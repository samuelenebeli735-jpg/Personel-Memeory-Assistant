/**
 * Ask API: evidence-grounded Q&A over the owner's stored records.
 *
 * POST /api/ask
 * Body: { question: string, types?: string[], limit?: number }
 * Response: AskResponse — { grounded, answer, evidence[], provider, deterministic }
 *
 * The route does no retrieval and no reasoning of its own: it validates the
 * request and delegates to `askQuestion`, which owns the grounding rules.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AskResponse } from '@recall/shared';

import type { AppContext } from '../../context.js';
import { ValidationError } from '../../lib/errors.js';
import { askQuestion, MAX_EVIDENCE_LIMIT, MAX_QUESTION_LENGTH } from '../../services/ask-service.js';

const askRequestSchema = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
  types: z
    .array(z.enum(['TASK', 'NOTE', 'IDEA', 'EVENT', 'CAPTURE', 'PROJECT', 'REMINDER']))
    .max(4)
    .optional(),
  limit: z.number().int().min(1).max(MAX_EVIDENCE_LIMIT).default(MAX_EVIDENCE_LIMIT),
});

export async function registerAskRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post('/ask', async (request): Promise<AskResponse> => {
    const parsed = askRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid ask request', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    return askQuestion(ctx, {
      question: parsed.data.question,
      types: parsed.data.types,
      limit: parsed.data.limit,
    });
  });
}
