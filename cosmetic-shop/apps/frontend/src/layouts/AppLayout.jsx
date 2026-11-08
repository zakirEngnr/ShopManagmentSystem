import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  BarChart3,
  User,
  Shield,
  LogOut,
} from 'lucide-react';

const NAVIGATION = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/pos', label: 'POS', icon: ShoppingCart },
  { to: '/products', label: 'Products', icon: Package },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
];

export default function AppLayout({ user, onLogout }) {
  const handleLogout = () => {
    onLogout();
  };

  return (
    <div className="flex h-screen text-slate-900">
      <aside className="w-72 border-r border-slate-200 bg-slate-50 flex flex-col">
        <div className="p-6 flex items-center gap-2">
          <Shield className="h-6 w-6 text-indigo-600" />
          <span className="font-semibold text-lg tracking-tight">Cosmetic Shop</span>
        </div>

        <div className="flex-1 overflow-y-auto">
          <nav className="p-4 space-y-1">
            {NAVIGATION.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                      isActive
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`
                  }
                >
                  <Icon className="h-5 w-5" />
                  {item.label}
                </NavLink>
              );
            })}
          </nav>
        </div>

        <div className="p-4 border-t border-slate-200">
          {user ? (
            <div className="space-y-2">
              <p className="px-4 text-xs text-slate-500 uppercase tracking-wider font-semibold">
                Signed in
              </p>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-white border border-slate-200">
                <User className="h-5 w-5 text-slate-400" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {user.name ?? 'User'}
                  </p>
                  {user.email && (
                    <p className="text-xs text-slate-500 truncate">
                      {user.email}
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              >
                <LogOut className="h-4 w-4" />
                Logout
              </button>
            </div>
          ) : (
            <p className="px-4 py-2 text-xs text-slate-400">Not authenticated</p>
          )}
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto bg-slate-100 p-8">
        <Outlet />
      </main>
    </div>
  );
}
