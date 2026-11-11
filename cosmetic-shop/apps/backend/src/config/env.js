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

const HOST = optional('HOST', '127.0.0.1');
if (typeof HOST !== 'string' || HOST.trim() === '') {
  throw new Error('HOST must be a non-empty hostname or IP address');
}

const JWT_SECRET = required('JWT_SECRET');

// Known values that must never be used in production. If the owner is still
// using one of them (for example after copying .env.example without editing),
// print a rotation banner to stderr and keep serving instead of crashing, so
// the owner can rotate at their own pace. Every other placeholder-like value
// is still rejected below.
const KNOWN_JWT_SECRET_VALUES = [
  '4e282daeb2ec134b89026155b58cf5ce32eccf14ae03011b538042c38af54aa2182dd93a', // previous .env.example value
  'CHANGE_ME_generate_with_node_-e_crypto_randomBytes_48_hex', // current .env.example placeholder
];

function printJwtSecretRotateBanner() {
  const lines = [
    'ROTATE YOUR JWT SECRET',
    'The JWT_SECRET is still set to a known example or placeholder value.',
    'Generate a new secret:',
    '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    'Then update .env and restart the server. All users must log in again.',
  ];
  process.stderr.write(lines.join('\n') + '\n');
}

let jwtSecretNeedsRotation = false;
for (const known of KNOWN_JWT_SECRET_VALUES) {
  if (JWT_SECRET === known) {
    printJwtSecretRotateBanner();
    jwtSecretNeedsRotation = true;
    break;
  }
}

if (!jwtSecretNeedsRotation) {
  if (JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  if (JWT_SECRET.includes('CHANGE') || JWT_SECRET.includes('dev-secret')) {
    throw new Error('JWT_SECRET appears to be a placeholder; generate a real secret');
  }
  const secretUpper = JWT_SECRET.toUpperCase();
  if (
    secretUpper.includes('REPLACE_WITH') ||
    secretUpper.includes('PLACEHOLDER') ||
    secretUpper.includes('EXAMPLE')
  ) {
    throw new Error('JWT_SECRET appears to be a placeholder; generate a real secret');
  }
}

export const env = Object.freeze({
  NODE_ENV,
  IS_PROD: NODE_ENV === 'production',
  PORT,
  HOST,
  DATABASE_URL: required('DATABASE_URL'),
  JWT_SECRET,
  UPLOAD_DIR: optional('UPLOAD_DIR', './uploads'),
});

export default env;
