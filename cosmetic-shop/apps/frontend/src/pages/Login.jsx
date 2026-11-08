import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import client, { TOKEN_STORAGE_KEY } from '../api/client';
import { Mail, Lock, User, Shield, LogIn } from 'lucide-react';

export default function Login({ isAuthenticated, onLogin }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Redirect already-authenticated users away from the login screen,
  // preserving the originally requested destination when available.
  // Only same-origin relative paths are allowed to avoid open redirects.
  const nextRaw = new URLSearchParams(location.search).get('next');
  const isSafePath = (path) => path.startsWith('/') && !path.startsWith('//');
  const next = isSafePath(nextRaw ?? '') ? nextRaw : '/';

  useEffect(() => {
    if (isAuthenticated) {
      navigate(next, { replace: true });
    }
  }, [isAuthenticated, navigate, next]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await client.post('/auth/login', { email, password });
      localStorage.setItem(TOKEN_STORAGE_KEY, response.data.token);
      onLogin(response.data.user);
      // Navigation is triggered once onLogin updates isAuthenticated (see useEffect).
    } catch (err) {
      const message =
        err.response?.data?.error?.message || 'Login failed. Please try again.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  if (isAuthenticated) {
    return null;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md w-full">
        <div className="flex items-center gap-2 mb-6">
          <Shield className="h-6 w-6 text-indigo-600" />
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Cosmetic Shop
          </h1>
        </div>
        <p className="text-sm text-slate-600 mb-8">Management System</p>

        <div className="bg-white p-8 rounded-xl shadow-sm border border-slate-200">
          <h2 className="text-base font-semibold text-slate-900 mb-6">
            Welcome back
          </h2>

          {error && (
            <div
              className="mb-6 p-3 rounded-md bg-red-50 text-red-700 text-sm border border-red-100"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">Email</label>
              <div className="relative">
                <User
                  className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
                />
                <input
                  type="email"
                  className="w-full pl-10 pr-3 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-700">
                Password
              </label>
              <div className="relative">
                <Lock
                  className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
                />
                <input
                  type="password"
                  className="w-full pl-10 pr-3 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition"
                  placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition"
              disabled={loading}
            >
              {loading ? (
                'Signing in...'
              ) : (
                <>
                  <LogIn className="h-4 w-4" /> Sign in
                </>
              )}
            </button>
          </form>

          <p className="mt-6 text-xs text-slate-500 text-center">
            Placeholder login page — credentials are validated against the backend API.
          </p>
        </div>
      </div>
    </div>
  );
}
