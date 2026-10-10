import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

export function parseBody<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Invalid request.',
      issues: parsed.error.issues.map(({ path, message }) => ({ path: path.join('.'), message })) });
  }
  return parsed.data;
}

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const devicePolicySchema = z.object({
  allowUnattendedAccess: z.boolean().optional(),
  requireMfa: z.boolean().optional(),
  allowClipboard: z.boolean().optional(),
  allowFileTransfer: z.boolean().optional(),
  requireSessionRecording: z.literal(false).optional(),
  userNotificationMode: z.literal('POPUP').optional(),
}).strict();
