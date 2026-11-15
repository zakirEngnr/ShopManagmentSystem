import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(200),
});

// Minimum password policy: matches the seed requirement (ADMIN_PASSWORD must
// be at least 12 characters). Kept in sync with the frontend validation.
export const MIN_PASSWORD_LENGTH = 12;

export const emailChangeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newEmail: z.string().trim().email().max(254).transform((v) => v.toLowerCase()),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(200),
});

export default { loginSchema, emailChangeSchema, passwordChangeSchema, MIN_PASSWORD_LENGTH };
