import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import client, { TOKEN_STORAGE_KEY } from './api/client';
import AppLayout from './layouts/AppLayout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import POS from './pages/POS';
import Products from './pages/Products';
import Reports from './pages/Reports';

function AppRouter() {
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const validateSession = async () => {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!token) {
        setUser(null);
        setLoading(false);
        return;
      }

      try {
        const response = await client.get('/auth/me');
        if (mounted) {
          setUser(response.data.user);
        }
      } catch (err) {
        if (mounted) {
          localStorage.removeItem(TOKEN_STORAGE_KEY);
          setUser(null);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    validateSession();
    return () => {
      mounted = false;
    };
  }, []);

  const isAuthenticated = !!user;

  const handleLogin = (authenticatedUser) => {
    setUser(authenticatedUser);
  };

  const handleLogout = () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setUser(null);
    navigate('/login', { replace: true });
  };

  if (loading) {
    return null;
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={<Login isAuthenticated={isAuthenticated} onLogin={handleLogin} />}
      />
      <Route
        path="/"
        element={
          isAuthenticated ? (
            <AppLayout user={user} onLogout={handleLogout} />
          ) : (
            <Navigate
              to={`/login?next=${encodeURIComponent(location.pathname)}`}
              replace
            />
          )
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="pos" element={<POS />} />
        <Route path="products" element={<Products />} />
        <Route path="reports" element={<Reports />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-slate-500">
      <h2 className="text-xl font-semibold">Not Found</h2>
      <p className="text-sm mt-2">The requested page does not exist.</p>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRouter />
    </BrowserRouter>
  );
}
