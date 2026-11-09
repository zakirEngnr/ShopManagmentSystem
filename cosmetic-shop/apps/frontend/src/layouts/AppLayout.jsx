import { Outlet, NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  BarChart3,
  ReceiptText,
  LogOut,
  Sparkles,
  Sun,
  Moon,
  Users,
  Wallet,
} from 'lucide-react';

const NAVIGATION = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/pos', label: 'Point of Sale', icon: ShoppingCart },
  { to: '/products', label: 'Products', icon: Package },
  { to: '/customers', label: 'Customers', icon: Users },
  { to: '/customers/outstanding', label: 'Outstanding Khata', icon: Wallet },
  { to: '/expenses', label: 'Expenses', icon: ReceiptText },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
];

export default function AppLayout({ user, onLogout, theme, onToggleTheme }) {
  const isDark = theme === 'dark';

  return (
    <div className="flex h-screen bg-[var(--app-bg)] text-[var(--app-text)] font-sans selection:bg-indigo-100">
      
      {/* Sidebar */}
      <aside className="w-72 bg-[var(--app-sidebar)] border-r border-[var(--app-border)] flex flex-col shadow-sm z-10 relative">
        
        {/* Branding Header */}
        <div className="h-24 flex flex-col justify-center px-6 border-b border-[var(--app-border)] bg-gradient-to-br from-indigo-50 to-white dark:from-indigo-950 dark:to-slate-900">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shadow-md shadow-indigo-200">
                <Sparkles className="h-4 w-4 text-white" />
              </div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">Eshal</h1>
            </div>
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text)] hover:border-indigo-500 hover:text-indigo-600 transition-colors"
            >
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-[10px] uppercase tracking-widest text-[var(--app-muted)] font-semibold mt-1 pl-10">
            Cosmetics & Jewellery
          </p>
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-y-auto py-6 px-4 space-y-1.5">
          <p className="px-4 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider mb-3">
            Menu
          </p>
          {NAVIGATION.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 group border ${
                    isActive
                      ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200 border-indigo-500'
                      : 'text-[var(--app-text-soft)] hover:bg-[var(--app-panel-2)] hover:text-indigo-600 border-transparent'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon
                      className={`h-5 w-5 transition-transform duration-200 group-hover:scale-110 ${
                        isActive ? 'text-white' : 'text-[var(--app-muted)] group-hover:text-indigo-600'
                      }`}
                    />
                    {item.label}
                  </>
                )}
              </NavLink>
            );
          })}
        </div>

        {/* User Profile Footer */}
        <div className="p-4 border-t border-[var(--app-border)] bg-[var(--app-panel-2)]/60">
          <div className="flex items-center gap-3 p-3 rounded-xl bg-[var(--app-panel)] border border-[var(--app-border)] shadow-sm mb-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-100 to-purple-100 flex items-center justify-center border border-indigo-200">
              <span className="text-sm font-bold text-indigo-700">
                {(user?.name || 'A').charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-[var(--app-text)] truncate">
                {user?.name ?? 'Admin'}
              </p>
              <p className="text-xs text-[var(--app-muted)] truncate">
                {user?.email ?? 'admin@eshal.com'}
              </p>
            </div>
          </div>
          
          <button
            onClick={onLogout}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-[var(--app-text-soft)] bg-[var(--app-panel)] border border-[var(--app-border)] rounded-xl hover:text-red-600 hover:bg-red-50 hover:border-red-100 transition-all duration-200"
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto p-8 lg:p-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}