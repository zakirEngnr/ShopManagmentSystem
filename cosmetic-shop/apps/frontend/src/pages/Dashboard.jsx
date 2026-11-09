import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  DollarSign,
  ReceiptText,
  RefreshCw,
  ShoppingCart,
  TrendingUp,
  Sparkles,
  Package,
} from 'lucide-react';
import {
  fetchDailyReport,
  fetchExpiringSoonProducts,
  fetchLowStockProducts,
} from '../api/reports';

const getInitialReport = () => ({
  revenue: null,
  netProfit: null,
  salesCount: null,
  expenses: null,
});

const formatCurrency = (value) => {
  if (value === null || value === undefined || value === '') return 'N/A';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  return `Rs. ${numeric.toLocaleString('en-PK', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
};

const formatCount = (value) => {
  if (value === null || value === undefined || value === '') return 'N/A';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  return Number.isInteger(numeric)
    ? numeric.toLocaleString('en-PK')
    : numeric.toLocaleString('en-PK', { maximumFractionDigits: 2 });
};

function parseSafeDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const date = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day))
    );
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

const formatDate = (value) => {
  const date = parseSafeDate(value);
  if (!date) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
};

const startOfTodayUtc = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const formatDaysRemaining = (value, referenceDate) => {
  const expiryDate = parseSafeDate(value);
  if (!expiryDate) return null;

  const reference = referenceDate
    ? parseSafeDate(referenceDate)
    : startOfTodayUtc();
  if (!reference) return null;

  const expiryDay = new Date(
    Date.UTC(
      expiryDate.getUTCFullYear(),
      expiryDate.getUTCMonth(),
      expiryDate.getUTCDate()
    )
  );
  const refDay = new Date(
    Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth(),
      reference.getUTCDate()
    )
  );

  const diffDays = (expiryDay - refDay) / 86400000;
  if (diffDays < 0) return 'Expired';
  if (diffDays === 0) return 'Today';
  const days = Math.round(diffDays);
  return `${days} day${days === 1 ? '' : 's'}`;
};

function validateDailyReport(response) {
  if (!response || typeof response !== 'object') return { valid: false };
  const report = response.report;
  if (!report || typeof report !== 'object') return { valid: false };
  const { revenue, netProfit, salesCount, expenses } = report;
  if (
    typeof revenue !== 'number' ||
    typeof netProfit !== 'number' ||
    typeof salesCount !== 'number' ||
    typeof expenses !== 'number'
  ) {
    return { valid: false };
  }
  return { valid: true, report };
}

function validateProductList(response) {
  if (!response || typeof response !== 'object') return { valid: false };
  const products = response.products;
  if (!Array.isArray(products)) return { valid: false };
  for (const product of products) {
    if (!product || typeof product !== 'object' || product.id == null) {
      return { valid: false };
    }
  }
  return { valid: true, products };
}

export default function Dashboard() {
  const [report, setReport] = useState(getInitialReport());
  const [lowStock, setLowStock] = useState([]);
  const [expiringSoon, setExpiringSoon] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [dailyError, setDailyError] = useState(null);
  const [lowStockError, setLowStockError] = useState(null);
  const [expiringError, setExpiringError] = useState(null);

  const requestIdRef = useRef(0);
  const busyRef = useRef(false);

  const loadDashboard = useCallback(async (manualRefresh = false) => {
    if (busyRef.current) return;

    const requestId = ++requestIdRef.current;
    const isCurrent = () => requestId === requestIdRef.current;

    busyRef.current = true;

    if (!manualRefresh) setLoading(true);
    else {
      setRefreshing(true);
      setRefreshError(null);
    }

    try {
      const results = await Promise.allSettled([
        fetchDailyReport(),
        fetchLowStockProducts(),
        fetchExpiringSoonProducts(30),
      ]);

      if (!isCurrent()) return;

      let dailyFailed = false;
      let lowStockFailed = false;
      let expiringFailed = false;

      const dailyResult = results[0];
      if (dailyResult.status === 'fulfilled') {
        const validated = validateDailyReport(dailyResult.value);
        if (validated.valid) {
          setReport(validated.report);
          setDailyError(null);
        } else {
          setDailyError('Daily report returned an invalid response.');
          dailyFailed = true;
        }
      } else {
        setDailyError('Failed to load daily report.');
        dailyFailed = true;
      }

      const lowStockResult = results[1];
      if (lowStockResult.status === 'fulfilled') {
        const validated = validateProductList(lowStockResult.value);
        if (validated.valid) {
          setLowStock(validated.products);
          setLowStockError(null);
        } else {
          setLowStockError('Low-stock data returned an invalid response.');
          lowStockFailed = true;
        }
      } else {
        setLowStockError('Failed to load low-stock data.');
        lowStockFailed = true;
      }

      const expiringResult = results[2];
      if (expiringResult.status === 'fulfilled') {
        const validated = validateProductList(expiringResult.value);
        if (validated.valid) {
          setExpiringSoon(validated.products);
          setExpiringError(null);
        } else {
          setExpiringError('Expiring-soon data returned an invalid response.');
          expiringFailed = true;
        }
      } else {
        setExpiringError('Failed to load expiring-soon data.');
        expiringFailed = true;
      }

      const anyFailed = dailyFailed || lowStockFailed || expiringFailed;

      if (manualRefresh) {
        if (anyFailed) {
          setRefreshError(
            'Some data could not be refreshed. Previous data is still shown.'
          );
        } else {
          setLastUpdated(new Date().toISOString());
        }
      }
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setRefreshing(false);
        busyRef.current = false;
      }
    }
  }, []);

  useEffect(() => {
    void loadDashboard(false);
    return () => {
      requestIdRef.current += 1;
      busyRef.current = false;
    };
  }, [loadDashboard]);

  const handleRefresh = () => void loadDashboard(true);

  const referenceDate = report?.date || null;

  const statCards = [
    { label: 'Revenue Today', value: report?.revenue, format: formatCurrency, color: 'text-emerald-600', bg: 'bg-emerald-100', gradient: 'from-emerald-400/20 to-teal-500/0', border: 'border-[var(--app-border)]', Icon: DollarSign },
    { label: 'Net Profit', value: report?.netProfit, format: formatCurrency, color: 'text-indigo-600', bg: 'bg-indigo-100', gradient: 'from-indigo-400/20 to-purple-500/0', border: 'border-[var(--app-border)]', Icon: TrendingUp },
    { label: 'Total Sales', value: report?.salesCount, format: formatCount, color: 'text-blue-600', bg: 'bg-blue-100', gradient: 'from-blue-400/20 to-cyan-500/0', border: 'border-[var(--app-border)]', Icon: ShoppingCart },
    { label: 'Total Expenses', value: report?.expenses, format: formatCurrency, color: 'text-amber-600', bg: 'bg-amber-100', gradient: 'from-amber-400/20 to-orange-500/0', border: 'border-[var(--app-border)]', Icon: ReceiptText },
  ];

  const renderSkeleton = () => (
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-sm animate-pulse">
          <div className="flex justify-between items-center"><div className="h-4 w-24 bg-slate-200 rounded" /><div className="h-10 w-10 bg-slate-200 rounded-xl" /></div>
          <div className="mt-6 h-8 w-32 bg-slate-200 rounded" />
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-8 animate-fade-in max-w-7xl mx-auto rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-[0_16px_40px_rgba(15,23,42,0.08)] sm:p-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="h-5 w-5 text-indigo-500" />
            <span className="text-xs font-bold text-indigo-600 uppercase tracking-widest">Overview</span>
          </div>
          <h1 className="text-3xl font-extrabold text-[var(--app-text)] tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-[var(--app-muted)] font-medium">Here's what's happening in your shop today.</p>
        </div>

        <div className="flex items-center gap-3">
          {lastUpdated && (
            <p className="text-xs text-[var(--app-muted)] font-medium">
              Last updated: {new Date(lastUpdated).toLocaleTimeString('en-PK', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          )}
          <button
            onClick={handleRefresh}
            disabled={loading || refreshing}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--app-panel-2)] border border-[var(--app-border)] px-5 py-2.5 text-sm font-bold text-[var(--app-text)] shadow-sm hover:bg-[var(--app-panel)] hover:border-slate-300 transition-all disabled:opacity-70"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin text-indigo-500' : 'text-[var(--app-muted)]'}`} />
            {refreshing ? 'Refreshing...' : 'Refresh Data'}
          </button>
        </div>
      </div>

      {refreshError && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm font-medium text-amber-700 shadow-sm flex justify-between items-center">
          <span>{refreshError}</span>
          <button
            onClick={handleRefresh}
            className="px-4 py-1.5 bg-white border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors text-sm font-medium text-amber-700"
          >
            Retry
          </button>
        </div>
      )}

      {loading ? (
        renderSkeleton()
      ) : (
        <>
          {dailyError && (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm font-medium text-red-700 shadow-sm">
              {dailyError}
            </div>
          )}

          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {statCards.map(({ label, value, format, color, bg, gradient, border, Icon }, i) => (
              <div
                key={label}
                style={{ animationDelay: `${i * 100}ms`, animationFillMode: 'both' }}
                className={`group relative rounded-3xl border ${border} bg-[var(--app-panel-2)] p-6 shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300 animate-slide-up overflow-hidden`}
              >
                <div className={`absolute top-0 right-0 w-32 h-32 bg-gradient-to-br ${gradient} opacity-100 rounded-bl-full group-hover:scale-110 transition-transform duration-500`} />
                <div className="flex items-center justify-between relative z-10">
                  <p className="text-sm font-bold text-[var(--app-muted)] uppercase tracking-wide">{label}</p>
                  <div className={`p-2.5 rounded-xl ${bg} ${color}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                </div>
                <div className="mt-6 text-3xl font-extrabold text-[var(--app-text)] tracking-tight relative z-10">
                  {format(value)}
                </div>
              </div>
            ))}
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <section className="rounded-3xl border border-red-200 bg-[var(--app-panel-2)] shadow-sm overflow-hidden animate-slide-up" style={{ animationDelay: '400ms', animationFillMode: 'both' }}>
              <div className="p-5 border-b border-red-100 bg-red-50/80 flex items-center gap-3">
                <div className="p-2 bg-red-100 rounded-xl text-red-600">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <h2 className="text-lg font-bold text-[var(--app-text)]">Low Stock Alerts</h2>
              </div>

              <div className="p-5">
                {lowStockError && (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700 mb-3">
                    {lowStockError}
                  </div>
                )}
                {!lowStockError && lowStock.length === 0 ? (
                  <div className="rounded-2xl border-2 border-dashed border-slate-200 p-6 text-center">
                    <p className="text-sm font-medium text-[var(--app-muted)]">No low stock items — you're all set!</p>
                  </div>
                ) : lowStock.length > 0 ? (
                  <div className="space-y-3">
                    {lowStock.map((product) => (
                      <div key={product.id} className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3 hover:bg-slate-50 transition-colors">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-8 h-8 rounded-lg bg-red-100 text-red-600 flex items-center justify-center flex-shrink-0">
                            <Package className="h-4 w-4" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-bold text-[var(--app-text)]">{product.name || 'Unnamed'}</p>
                            <p className="text-[10px] text-[var(--app-muted)] font-medium">{product.sku || 'No SKU'}</p>
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <span className="inline-block bg-red-100 text-red-700 font-bold px-2.5 py-1 rounded-md text-xs border border-red-200">
                            {product.stock === null || product.stock === undefined ? 'N/A' : product.stock} left
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </section>

            <section className="rounded-3xl border border-orange-200 bg-[var(--app-panel-2)] shadow-sm overflow-hidden animate-slide-up" style={{ animationDelay: '500ms', animationFillMode: 'both' }}>
              <div className="p-5 border-b border-orange-100 bg-orange-50/80 flex items-center gap-3">
                <div className="p-2 bg-orange-100 rounded-xl text-orange-600">
                  <CalendarClock className="h-5 w-5" />
                </div>
                <h2 className="text-lg font-bold text-[var(--app-text)]">Expiring Soon</h2>
              </div>

              <div className="p-5">
                {expiringError && (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700 mb-3">
                    {expiringError}
                  </div>
                )}
                {!expiringError && expiringSoon.length === 0 ? (
                  <div className="rounded-2xl border-2 border-dashed border-slate-200 p-6 text-center">
                    <p className="text-sm font-medium text-[var(--app-muted)]">No products expiring in the next 30 days.</p>
                  </div>
                ) : expiringSoon.length > 0 ? (
                  <div className="space-y-3">
                    {expiringSoon.map((product) => {
                      const days = formatDaysRemaining(product.expiryDate, referenceDate);
                      return (
                        <div key={product.id} className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3 hover:bg-slate-50 transition-colors">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-8 h-8 rounded-lg bg-orange-100 text-orange-600 flex items-center justify-center flex-shrink-0">
                              <CalendarClock className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-bold text-[var(--app-text)]">{product.name || 'Unnamed'}</p>
                              <p className="text-[10px] text-[var(--app-muted)] font-medium">{formatDate(product.expiryDate)}</p>
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <span className={`inline-block font-bold px-2.5 py-1 rounded-md text-xs border ${
                              days === 'Expired' || days === 'Today'
                                ? 'bg-red-100 text-red-700 border-red-200'
                                : days === null
                                  ? 'bg-slate-100 text-slate-700 border-slate-200'
                                  : 'bg-orange-100 text-orange-700 border-orange-200'
                            }`}>
                              {days === null
                                ? 'Date unavailable'
                                : days === 'Expired' || days === 'Today'
                                  ? days
                                  : `In ${days}`}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}