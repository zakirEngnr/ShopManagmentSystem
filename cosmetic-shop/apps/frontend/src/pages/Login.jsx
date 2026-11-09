import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import client, { TOKEN_STORAGE_KEY } from '../api/client';
import { Mail, Lock, Shield, LogIn, Sparkles, Eye, EyeOff, Sun, Moon } from 'lucide-react';

export default function Login({ isAuthenticated, onLogin, theme, onToggleTheme }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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

  const isDark = theme === 'dark';

  return (
    <div className="min-h-screen flex bg-[var(--app-bg)] text-[var(--app-text)] relative overflow-hidden font-sans selection:bg-indigo-900 selection:text-white">
      <button
        type="button"
        onClick={onToggleTheme}
        className="absolute right-6 top-6 z-20 inline-flex items-center gap-2 rounded-full border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-2 text-sm font-medium text-[var(--app-text)] shadow-lg shadow-slate-900/5 transition-colors hover:border-indigo-500 hover:text-indigo-600"
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        {isDark ? 'Light mode' : 'Dark mode'}
      </button>
      
      {/* Dark aesthetic glowing background blobs */}
      <div className="absolute top-[-10%] left-[-10%] w-[40rem] h-[40rem] bg-indigo-900/20 rounded-full mix-blend-screen filter blur-[100px] animate-blob"></div>
      <div className="absolute top-[20%] right-[-10%] w-[40rem] h-[40rem] bg-purple-900/20 rounded-full mix-blend-screen filter blur-[100px] animate-blob animation-delay-2000"></div>
      <div className="absolute bottom-[-20%] left-[20%] w-[40rem] h-[40rem] bg-blue-900/20 rounded-full mix-blend-screen filter blur-[100px] animate-blob animation-delay-4000"></div>

      {/* Left side - Branding */}
      <div className="hidden lg:flex lg:w-1/2 relative flex-col justify-center items-center p-12 z-10 border-r border-slate-800/50">
        <div className="max-w-md text-center space-y-6">
          <div className="mx-auto w-20 h-20 bg-slate-900 rounded-3xl shadow-[0_0_40px_-10px_rgba(79,70,229,0.3)] border border-slate-800 flex items-center justify-center mb-8 animate-float">
            <Sparkles className="w-10 h-10 text-indigo-400" />
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight leading-tight">
            Eshal <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400">
              Cosmetics & Jewellery
            </span>
          </h1>
          <p className="text-lg text-slate-400 font-medium">
            The elegant way to manage your cosmetics, artificial jewellery, inventory, and sales. Beautifully designed for your business.
          </p>
        </div>
      </div>

      {/* Right side - Login Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-6 z-10">
        <div className="w-full max-w-md">
          
          {/* Logo for mobile */}
          <div className="lg:hidden flex flex-col items-center justify-center gap-2 mb-8">
            <div className="flex items-center gap-2">
              <Shield className="h-8 w-8 text-indigo-400" />
              <h1 className="text-2xl font-bold text-white">Eshal</h1>
            </div>
            <p className="text-sm text-slate-400 font-medium tracking-wide">Cosmetics & Artificial Jewellery</p>
          </div>

          <div className="bg-slate-900/60 backdrop-blur-2xl p-8 sm:p-10 rounded-3xl shadow-2xl border border-slate-800 relative overflow-hidden group">
            {/* Subtle glow inside the card */}
            <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 to-purple-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>

            <div className="mb-8 text-center sm:text-left relative z-10">
              <h2 className="text-3xl font-bold text-white mb-2">Welcome back</h2>
              <p className="text-slate-400">Enter your credentials to access your dashboard.</p>
            </div>

            {error && (
              <div className="mb-6 p-4 rounded-xl bg-red-950/50 text-red-400 text-sm border border-red-900/50 flex items-center gap-2 animate-shake relative z-10">
                <span className="font-medium">Error:</span> {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-6 relative z-10">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-400">Email Address</label>
                <div className="relative group/input">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Mail className="h-5 w-5 text-slate-500 group-focus-within/input:text-indigo-400 transition-colors" />
                  </div>
                  <input
                    type="email"
                    className="w-full pl-11 pr-4 py-3.5 bg-slate-950/50 border border-slate-800 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all duration-300 text-white placeholder:text-slate-600"
                    placeholder="admin@eshal.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={loading}
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="block text-sm font-medium text-slate-400">Password</label>
                  <button type="button" className="text-xs text-indigo-400 hover:text-indigo-300 font-medium transition-colors">
                    Forgot password?
                  </button>
                </div>
                <div className="relative group/input">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Lock className="h-5 w-5 text-slate-500 group-focus-within/input:text-indigo-400 transition-colors" />
                  </div>
                  <input
                    type={showPassword ? "text" : "password"}
                    className="w-full pl-11 pr-12 py-3.5 bg-slate-950/50 border border-slate-800 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all duration-300 text-white placeholder:text-slate-600"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={loading}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 pr-4 flex items-center text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                className="w-full flex items-center justify-center gap-2 px-6 py-3.5 text-base font-semibold text-white bg-gradient-to-r from-indigo-600 to-purple-600 rounded-xl hover:from-indigo-500 hover:to-purple-500 hover:shadow-[0_0_20px_-5px_rgba(79,70,229,0.5)] hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300"
                disabled={loading}
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Signing in...
                  </span>
                ) : (
                  <>
                    <LogIn className="h-5 w-5" /> Sign in to Dashboard
                  </>
                )}
              </button>
            </form>

            <p className="mt-8 text-center text-sm text-slate-500 relative z-10">
              Having trouble? <a href="#" className="font-semibold text-indigo-400 hover:text-indigo-300 transition-colors">Contact support</a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}