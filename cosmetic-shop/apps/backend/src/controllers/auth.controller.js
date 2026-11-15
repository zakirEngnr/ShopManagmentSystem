import { parse } from '../middleware/validate.js';
import { loginSchema, emailChangeSchema, passwordChangeSchema } from '../schemas/auth.schema.js';
import {
  login as loginService,
  getUserById,
  changeEmail as changeEmailService,
  changePassword as changePasswordService,
} from '../services/auth.service.js';

export async function login(req, res, next) {
  try {
    const { email, password } = parse(loginSchema, req.body);
    const result = await loginService(email, password);
    res.json({ ok: true, ...result });
  } catch (err) {
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

export async function changeEmail(req, res, next) {
  try {
    const { currentPassword, newEmail } = parse(emailChangeSchema, req.body);
    const result = await changeEmailService(req.user.userId, { currentPassword, newEmail });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

export async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = parse(passwordChangeSchema, req.body);
    const result = await changePasswordService(req.user.userId, {
      currentPassword,
      newPassword,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
}

export default { login, me, changeEmail, changePassword };
