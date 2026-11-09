import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  DollarSign,
  ReceiptText,
  RefreshCw,
  ShoppingCart,
  TrendingUp,
} from 'lucide-react';
import {
  fetchDailyReport,
  fetchExpiringSoonProducts,
  fetchLowStockProducts,
} from '../api/reports';

const formatCurrency = (value) => {
  if (value === null || value === undefined || value === '') {
    return 'N/A';
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 'N/A';
  }

  return `Rs. ${numeric.toLocaleString('en-PK', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
};

const formatCount = (value) => {
  if (value === null || value === undefined || value === '') {
    return 'N/A';
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 'N/A';
  }

  return Number.isInteger(numeric)
    ? numeric.toLocaleString('en-PK')
    : numeric.toLocaleString('en-PK', { maximumFractionDigits: 2 });
};

const formatDate = (value) => {
  if (!value) return 'N/A';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'N/A';
  }

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
};

const formatDaysRemaining = (value) => {
  if (!value) return null;

  const expiryDate = new Date(value);
  if (Number.isNaN(expiryDate.getTime())) {
    return null;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  expiryDate.setHours(0, 0, 0, 0);

  const diffInDays = Math.round((expiryDate - today) / 86400000);
  if (diffInDays < 0) {
    return 'Expired';
  }

  if (diffInDays === 0) {
    return 'Today';
  }

  return `${diffInDays} day${diffInDays === 1 ? '' : 's'}`;
};

const getInitialReport = () => ({
  revenue: null,
  netProfit: null,
  salesCount: null,
  expenses: null,
});

export default function Dashboard() {
  const [report, setReport] = useState(getInitialReport);
  const [lowStock, setLowStock] = useState([]);
  const [expiringSoon, setExpiringSoon] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  const loadDashboard = useCallback(async (manualRefresh = false) => {
    if (busyRef.current) {
      return;
    }

    busyRef.current = true;
    const requestId = ++requestIdRef.current;

    if (!manualRefresh) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    setError(null);

    try {
      const [dailyResponse, lowStockResponse, expiringSoonResponse] = await Promise.all([
        fetchDailyReport(),
        fetchLowStockProducts(),
        fetchExpiringSoonProducts(30),
      ]);

      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return;
      }

      setReport(dailyResponse?.report ?? getInitialReport());
      setLowStock(Array.isArray(lowStockResponse?.products) ? lowStockResponse.products : []);
      setExpiringSoon(Array.isArray(expiringSoonResponse?.products) ? expiringSoonResponse.products : []);
    } catch (err) {
      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return;
      }

      const message = err?.response?.status === 401
        ? 'Your session expired. Please sign in again.'
        : 'Dashboard data could not be loaded. Please try again.';
      setError(message);
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
      busyRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadDashboard(false);

    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      busyRef.current = false;
    };
  }, [loadDashboard]);

  const handleRefresh = () => {
    void loadDashboard(true);
  };

  const hasReportData = [report?.revenue, report?.netProfit, report?.salesCount, report?.expenses]
    .some((value) => value !== null && value !== undefined && value !== '');

  const statCards = [
    {
      label: 'Revenue Today',
      value: report?.revenue,
      format: formatCurrency,
      accent: 'emerald',
      Icon: DollarSign,
    },
    {
      label: 'Net Profit',
      value: report?.netProfit,
      format: formatCurrency,
      accent: 'indigo',
      Icon: TrendingUp,
    },
    {
      label: 'Total Sales',
      value: report?.salesCount,
      format: formatCount,
      accent: 'blue',
      Icon: ShoppingCart,
    },
    {
      label: 'Total Expenses',
      value: report?.expenses,
      format: formatCurrency,
      accent: 'amber',
      Icon: ReceiptText,
    },
  ];

  const cardClassByAccent = {
    emerald: 'border-emerald-200 bg-emerald-50/70 text-emerald-700',
    indigo: 'border-indigo-200 bg-indigo-50/70 text-indigo-700',
    blue: 'border-blue-200 bg-blue-50/70 text-blue-700',
    amber: 'border-amber-200 bg-amber-50/70 text-amber-700',
  };

  const renderSkeleton = () => (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          key={`stat-skeleton-${index}`}
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm animate-pulse"
        >
          <div className="h-4 w-20 rounded bg-slate-200" />
          <div className="mt-5 h-8 w-28 rounded bg-slate-200" />
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-600">
            Welcome back. Here's your shop's overview for today.
          </p>
        </div>

        <button
          type="button"
          onClick={handleRefresh}
          disabled={loading || refreshing}
          aria-label="Refresh dashboard"
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-indigo-300 hover:text-indigo-600 disabled:cursor-not-allowed disabled:opacity-70"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {error && !hasReportData && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          <div className="flex items-center justify-between gap-4">
            <span>{error}</span>
            <button
              type="button"
              onClick={handleRefresh}
              className="rounded-lg border border-red-200 bg-white px-3 py-1.5 font-medium text-red-700 transition hover:border-red-300 hover:bg-red-100"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {loading && !hasReportData ? (
        renderSkeleton()
      ) : !hasReportData ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
          Dashboard data is unavailable right now.
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {statCards.map(({ label, value, format, accent, Icon }) => (
              <div
                key={label}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-slate-500">{label}</p>
                  <div className={`rounded-xl border p-2 ${cardClassByAccent[accent]}`}>
                    <Icon className="h-4 w-4" />
                  </div>
                </div>
                <div className="mt-6 text-2xl font-bold tracking-tight text-slate-900">
                  {format(value)}
                </div>
              </div>
            ))}
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <section className="rounded-2xl border border-red-100 bg-red-50/40 p-5 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="rounded-lg bg-red-100 p-2 text-red-600">
                    <AlertTriangle className="h-4 w-4" />
                  </div>
                  <h2 className="text-lg font-semibold text-slate-900">Low Stock Alerts</h2>
                </div>
              </div>

              {lowStock.length === 0 ? (
                <div className="rounded-xl border border-dashed border-red-200 bg-white/70 p-4 text-sm text-slate-600">
                  No low stock items — you're all set!
                </div>
              ) : (
                <div className="space-y-3">
                  {lowStock.map((product) => (
                    <div
                      key={product.id ?? `${product.name ?? 'low-stock'}-${product.sku ?? 'sku'}`}
                      className="flex items-center justify-between gap-3 rounded-xl border border-red-100 bg-white px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">
                          {product.name || 'Unnamed Product'}
                        </p>
                        <p className="text-xs text-slate-500">
                          {product.sku ? `SKU: ${product.sku}` : 'No SKU'}
                        </p>
                      </div>
                      <div className="text-right text-xs text-slate-600">
                        <div className="font-medium text-red-600">Stock: {product.stock ?? 'N/A'}</div>
                        <div>Threshold: {product.lowStockAt ?? 'N/A'}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-orange-100 bg-orange-50/40 p-5 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="rounded-lg bg-orange-100 p-2 text-orange-600">
                    <CalendarClock className="h-4 w-4" />
                  </div>
                  <h2 className="text-lg font-semibold text-slate-900">Expiring Soon</h2>
                </div>
              </div>

              {expiringSoon.length === 0 ? (
                <div className="rounded-xl border border-dashed border-orange-200 bg-white/70 p-4 text-sm text-slate-600">
                  No products expiring soon.
                </div>
              ) : (
                <div className="space-y-3">
                  {expiringSoon.map((product) => {
                    const daysRemaining = formatDaysRemaining(product.expiryDate);

                    return (
                      <div
                        key={product.id ?? `${product.name ?? 'expiring'}-${product.expiryDate ?? 'date'}`}
                        className="flex items-center justify-between gap-3 rounded-xl border border-orange-100 bg-white px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-900">
                            {product.name || 'Unnamed Product'}
                          </p>
                          <p className="text-xs text-slate-500">
                            {product.sku ? `SKU: ${product.sku}` : 'No SKU'}
                          </p>
                        </div>
                        <div className="text-right text-xs text-slate-600">
                          <div className="font-medium text-orange-600">
                            {formatDate(product.expiryDate)}
                          </div>
                          <div>
                            {daysRemaining === 'Expired' || daysRemaining === 'Today'
                              ? daysRemaining
                              : daysRemaining
                                ? `In ${daysRemaining}`
                                : 'Date unavailable'}
                          </div>
                          {product.stock !== null && product.stock !== undefined ? (
                            <div>Stock: {product.stock}</div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
