import { z } from 'zod';
import { httpError } from '../utils/prismaErrors.js';

/**
 * Sanitize a single path segment for public output.
 * Only allow safe identifiers; everything else becomes a fixed token.
 */
function sanitizeSegment(seg) {
  const s = String(seg);
  if (/^[A-Za-z0-9_-]{1,64}$/.test(s)) return s;
  return 'value';
}

/** Build a safe dotted path (max 5 segments) or '(root)'. */
function safePath(path) {
  if (!Array.isArray(path) || path.length === 0) return '(root)';
  return path.slice(0, 5).map(sanitizeSegment).join('.');
}

/**
 * Map known Zod issue codes to fixed generic descriptions.
 * Never interpolates submitted values, attacker-controlled strings,
 * unknown property names, or raw issue.message text.
 */
function safeDescription(issue) {
  switch (issue?.code) {
    case 'invalid_type':
      return 'invalid type';
    case 'invalid_literal':
      return 'invalid value';
    case 'unrecognized_keys':
      return 'unknown field';
    case 'invalid_union':
      return 'invalid value';
    case 'invalid_union_discriminator':
      return 'invalid value';
    case 'invalid_enum_value':
      return 'invalid value';
    case 'invalid_string':
      return 'invalid string';
    case 'too_small':
      return 'value too short';
    case 'too_big':
      return 'value too long';
    case 'custom':
      return 'invalid value';
    default:
      return 'invalid value';
  }
}

/**
 * Parse `data` with a zod schema.
 * Returns the parsed value or throws httpError(400, 'Validation failed: ...').
 * Public messages contain only sanitized paths and fixed generic
 * descriptions — never submitted values, passwords, unknown property names,
 * or raw Zod messages.
 */
export function parse(schema, data) {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const parts = err.issues.map((issue) => `${safePath(issue.path)}: ${safeDescription(issue)}`);
      throw httpError(400, `Validation failed: ${parts.join('; ')}`);
    }
    throw err;
  }
}

/**
 * Common id param schema: positive integer ids (`/^[1-9]\d*$/`)
 * that are also safe integers. Otherwise 400 via `parse`.
 */
export const idParamSchema = z
  .object({
    id: z
      .string()
      .regex(/^[1-9]\d*$/, { message: 'Invalid id' })
      .refine((s) => Number.isSafeInteger(Number(s)), { message: 'Invalid id' }),
  })
  .strict();

/** Parse `req.params` and return the numeric id (throws 400 on invalid). */
export function parseId(params) {
  const parsed = parse(idParamSchema, params);
  return Number(parsed.id);
}

export default { parse, idParamSchema, parseId };

