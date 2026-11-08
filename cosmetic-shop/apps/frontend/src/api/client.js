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

const apiBase = (import.meta.env.VITE_API_URL || 'http://localhost:4000')
  .replace(/\/+$/, '');

const client = axios.create({
  baseURL: `${apiBase}/api`,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

// Attach the stored Bearer token to outgoing requests.
// FormData requests keep their auto-generated multipart boundary because Axios
// overrides the default Content-Type for FormData bodies.
client.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export default client;
