import axios from 'axios';

// Storage key for the Bearer token issued by the backend.
// The backend authenticates via Authorization: Bearer <token> (not HttpOnly cookies).
export const TOKEN_STORAGE_KEY = 'cosmetic-shop-token';

const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
};

const client = axios.create({
  baseURL: '/api',
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

// Attach the stored Bearer token to outgoing requests.
// Multipart uploads must not keep the default JSON Content-Type, or the
// browser will send FormData as a plain JSON object and the server will not
// receive the uploaded file.
client.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  if (config.data instanceof FormData) {
    delete config.headers['Content-Type'];
    delete config.headers['content-type'];
  }

  return config;
});

export default client;
