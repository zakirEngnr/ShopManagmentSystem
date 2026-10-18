import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const NODE_ENV = optional('NODE_ENV', 'development');

const PORT_RAW = optional('PORT', '4000');
const PORT = Number(PORT_RAW);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`Invalid PORT: ${PORT_RAW}`);
}

const JWT_SECRET = required('JWT_SECRET');
if (JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters');
}
if (JWT_SECRET.includes('CHANGE') || JWT_SECRET.includes('dev-secret')) {
  throw new Error('JWT_SECRET appears to be a placeholder; generate a real secret');
}

export const env = Object.freeze({
  NODE_ENV,
  IS_PROD: NODE_ENV === 'production',
  PORT,
  DATABASE_URL: required('DATABASE_URL'),
  JWT_SECRET,
  UPLOAD_DIR: optional('UPLOAD_DIR', './uploads'),
});

export default env;
