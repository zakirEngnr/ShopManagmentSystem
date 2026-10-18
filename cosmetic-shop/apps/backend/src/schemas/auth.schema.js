import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(200),
});

export default { loginSchema };
