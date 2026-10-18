import { ZodError } from 'zod';
import { loginSchema } from '../schemas/auth.schema.js';
import { login as loginService, getUserById } from '../services/auth.service.js';

export async function login(req, res, next) {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const result = await loginService(email, password);
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ZodError) {
      err.status = 400;
      err.expose = true;
    }
    next(err);
  }
}

export async function me(req, res, next) {
  try {
    const user = await getUserById(req.user.userId);
    res.json({ ok: true, user });
  } catch (err) {
    next(err);
  }
}

export default { login, me };
