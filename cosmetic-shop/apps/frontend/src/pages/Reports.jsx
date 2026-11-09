import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Clock,
  DollarSign,
  Factory,
  RefreshCw,
  ReceiptText,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { fetchPnlReport, fetchTopProducts } from '../api/reports';

function toUtcDateString(date) {
  return (
    date.getUTCFullYear() +
    '-' +
    String(date.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(date.getUTCDate()).padStart(2, '0')
  );
}

function getTodayUtcString() {
  return toUtcDateString(new Date());
}

function getMondayOfWeekUtcString() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + offset);
  return toUtcDateString(d);
}

function getFirstDayOfMonthUtcString() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return toUtcDateString(d);
}

function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

function validateCustomRange(from, to) {
  if (!from || !to) return { valid: false, error: 'Both dates are required.' };
  if (!isValidDateString(from)) return { valid: false, error: 'Invalid From date.' };
  if (!isValidDateString(to)) return { valid: false, error: 'Invalid To date.' };
  if (from > to) return { valid: false, error: 'From date must not be after To date.' };
  return { valid: true, error: null };
}

function formatCurrency(value) {
  if (value === null || value === undefined || value === '') return 'N/A';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  return `Rs. ${numeric.toLocaleString('en-PK', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function formatCount(value) {
  if (value === null || value === undefined || value === '') return 'N/A';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  return Number.isInteger(numeric)
    ? numeric.toLocaleString('en-PK')
    : numeric.toLocaleString('en-PK', { maximumFractionDigits: 2 });
}

const PRESETS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This Week' },
  { id: 'month', label: 'This Month' },
  { id: 'custom', label: 'Custom' },
];

const getInitialPnl = () => ({
  revenue: null,
  discount: null,
  netSales: null,
  cogs: null,
  grossProfit: null,
  expenses: null,
  netProfit: null,
});

export default function Reports() {
  const [preset, setPreset] = useState('today');
  const [customFrom, setCustomFrom] = useState(getTodayUtcString());
  const [customTo, setCustomTo] = useState(getTodayUtcString());

  const [pnl, setPnl] = useState(getInitialPnl());
  const [topProducts, setTopProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [pnlError, setPnlError] = useState(null);
  const [productsError, setProductsError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const requestIdRef = useRef(0);
  const busyRef = useRef(false);

  const today = getTodayUtcString();
  const monday = getMondayOfWeekUtcString();
  const firstOfMonth = getFirstDayOfMonthUtcString();

  const selectedFrom =
    preset === 'today' ? today : preset === 'week' ? monday : preset === 'month' ? firstOfMonth : customFrom;
  const selectedTo =
    preset === 'today' ? today : preset === 'week' ? today : preset === 'month' ? today : customTo;

  const { valid: customValid, error: customValidationError } = validateCustomRange(selectedFrom, selectedTo);
  const canFetch = preset !== 'custom' || customValid;
  const fetchReports = useCallback(
    async (isRefresh = false) => {
      if (!canFetch) return;
      if (busyRef.current) return;

      const requestId = ++requestIdRef.current;
      busyRef.current = true;

      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      setPnlError(null);
      setProductsError(null);

      try {
        const results = await Promise.allSettled([
          fetchPnlReport(selectedFrom, selectedTo),
          fetchTopProducts(selectedFrom, selectedTo, 10),
        ]);

        if (requestId !== requestIdRef.current) return;

        const pnlResult = results[0];
        const productsResult = results[1];

        if (pnlResult.status === 'fulfilled') {
          setPnl(pnlResult.value);
          setPnlError(null);
        } else {
          setPnlError(pnlResult.reason instanceof Error ? pnlResult.reason.message : String(pnlResult.reason));
        }

        if (productsResult.status === 'fulfilled') {
          setTopProducts(productsResult.value);
          setProductsError(null);
        } else {
          setProductsError(
            productsResult.reason instanceof Error ? productsResult.reason.message : String(productsResult.reason),
          );
        }

        if (pnlResult.status === 'rejected' && productsResult.status === 'rejected') {
          setError('Failed to load P&L report and top products. Please try again.');
        } else {
          setError(null);
        }
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
      } finally {
        if (requestId === requestIdRef.current) {
          setLastUpdated(new Date());
          setLoading(false);
          setRefreshing(false);
          busyRef.current = false;
        }
      }
    },
    [selectedFrom, selectedTo, canFetch],
  );

  useEffect(() => {
    fetchReports(false);
    return () => {
      requestIdRef.current += 1;
      busyRef.current = false;
    };
  }, [fetchReports]);

  const handleRefresh = () => void fetchReports(true);

  const handlePresetChange = (id) => {
    setPreset(id);
    if (id === 'today') {
      setCustomFrom(today);
      setCustomTo(today);
    } else if (id === 'week') {
      setCustomFrom(monday);
      setCustomTo(today);
    } else if (id === 'month') {
      setCustomFrom(firstOfMonth);
      setCustomTo(today);
    }
  };

  const netProfit = pnl.netProfit;
  const isLoss = typeof netProfit === 'number' && netProfit < 0;
  const isBreakEven = typeof netProfit === 'number' && netProfit === 0;

  const statCards = [
    {
      label: 'Revenue',
      value: pnl.revenue,
      format: formatCurrency,
      color: 'text-emerald-600 dark:text-emerald-400',
      bg: 'bg-emerald-50 dark:bg-emerald-900/20',
      border: 'border-[var(--app-border)]',
      Icon: DollarSign,
    },
    {
      label: 'Cost of Goods',
      value: pnl.cogs,
      format: formatCurrency,
      color: 'text-amber-600 dark:text-amber-400',
      bg: 'bg-amber-50 dark:bg-amber-900/20',
      border: 'border-[var(--app-border)]',
      Icon: Factory,
    },
    {
      label: 'Expenses',
      value: pnl.expenses,
      format: formatCurrency,
      color: 'text-orange-600 dark:text-orange-400',
      bg: 'bg-orange-50 dark:bg-orange-900/20',
      border: 'border-[var(--app-border)]',
      Icon: ReceiptText,
    },
    {
      label: 'Net Profit',
      value: pnl.netProfit,
      format: formatCurrency,
      color: isLoss ? 'text-red-600 dark:text-red-400' : 'text-indigo-600 dark:text-indigo-400',
      bg: isLoss ? 'bg-red-50 dark:bg-red-900/20' : 'bg-indigo-50 dark:bg-indigo-900/20',
      border: 'border-[var(--app-border)]',
      Icon: isLoss ? TrendingDown : TrendingUp,
    },
  ];

  const renderSkeleton = () => (
    <div className="space-y-6">
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-sm animate-pulse"
          >
            <div className="flex justify-between items-center">
              <div className="h-4 w-24 bg-slate-200 dark:bg-slate-800 rounded" />
              <div className="h-10 w-10 bg-slate-200 dark:bg-slate-800 rounded-xl" />
            </div>
            <div className="mt-6 h-8 w-32 bg-slate-200 dark:bg-slate-800 rounded" />
          </div>
        ))}
      </div>
      <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-sm animate-pulse min-h-[300px]" />
      <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-sm animate-pulse min-h-[300px]" />
    </div>
  );

  const renderRangeLabel = () => {
    if (preset === 'today') return `Today — ${today}`;
    if (preset === 'week') return `This Week — ${monday} to ${today}`;
    if (preset === 'month') return `This Month — ${firstOfMonth} to ${today}`;
    return `Custom — ${selectedFrom} to ${selectedTo}`;
  };
  return (
    <div className="space-y-6 animate-fade-in max-w-7xl mx-auto">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Clock className="h-5 w-5 text-indigo-500" />
            <span className="text-xs font-bold text-indigo-600 uppercase tracking-widest">Reports &amp; P&L</span>
          </div>
          <h1 className="text-3xl font-extrabold text-[var(--app-text)] tracking-tight">Reports &amp; P&L</h1>
          <p className="mt-1 text-sm text-[var(--app-muted)] font-medium">
            Analyze your shop's financial performance.
          </p>
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
            disabled={loading || refreshing || !canFetch}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--app-panel-2)] border border-[var(--app-border)] px-5 py-2.5 text-sm font-bold text-[var(--app-text)] shadow-sm hover:bg-[var(--app-panel)] hover:border-slate-300 transition-all disabled:opacity-70"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin text-indigo-500' : 'text-[var(--app-muted)]'}`} />
            {refreshing ? 'Refreshing...' : 'Refresh Data'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm font-medium text-red-700 shadow-sm flex justify-between items-center">
          <span>{error}</span>
          <button
            onClick={handleRefresh}
            className="px-4 py-1.5 bg-white dark:bg-slate-800 border border-red-200 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/20 transition-colors text-sm font-medium text-red-700 dark:text-red-400"
          >
            Retry
          </button>
        </div>
      )}

      <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-[var(--app-text)] uppercase tracking-wider">Date Range</h2>
          <p className="text-xs text-[var(--app-muted)] font-medium">{renderRangeLabel()}</p>
        </div>
        <div className="flex gap-2">
          {PRESETS.map((p) => {
            const active = preset === p.id;
            return (
              <button
                key={p.id}
                onClick={() => handlePresetChange(p.id)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all border ${
                  active
                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                    : 'bg-[var(--app-panel-2)] text-[var(--app-text-soft)] border-[var(--app-border)] hover:bg-[var(--app-panel)] hover:border-slate-300 dark:hover:text-white'
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        {preset === 'custom' && (
          <div className="mt-4 flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[var(--app-text-soft)]">From</label>
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                min="2000-01-01"
                className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] focus:ring-2 focus:ring-indigo-500 outline-none transition-colors"
                disabled={loading || refreshing}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-[var(--app-text-soft)]">To</label>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                min="2000-01-01"
                className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] focus:ring-2 focus:ring-indigo-500 outline-none transition-colors"
                disabled={loading || refreshing}
              />
            </div>
            {!customValid && (
              <p className="text-xs text-red-600 dark:text-red-400 font-medium">{customValidationError}</p>
            )}
          </div>
        )}
      </div>

      {loading && !pnl.revenue && !pnl.cogs && !pnl.expenses && !pnl.netProfit ? (
        renderSkeleton()
      ) : (
        <>
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {statCards.map(({ label, value, format, color, bg, border, Icon }, i) => (
              <div
                key={label}
                style={{ animationDelay: `${i * 100}ms`, animationFillMode: 'both' }}
                className={`group relative rounded-3xl border ${border} bg-[var(--app-panel-2)] p-6 shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300 animate-slide-up overflow-hidden`}
              >
                <div className={`absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-${color.split(' ')[0].replace('text-', '')}-400/20 to-transparent opacity-100 rounded-bl-full group-hover:scale-110 transition-transform duration-500`} />
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

          <section className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel-2)] shadow-sm overflow-hidden animate-slide-up" style={{ animationDelay: '400ms', animationFillMode: 'both' }}>
            <div className="p-5 border-b border-[var(--app-border)] bg-[var(--app-panel)] flex items-center justify-between">
              <h2 className="text-lg font-bold text-[var(--app-text)]">Profit &amp; Loss Statement</h2>
              <span className="text-xs font-medium text-[var(--app-muted)] uppercase tracking-wider">{renderRangeLabel()}</span>
            </div>
            <div className="divide-y divide-[var(--app-border)] p-5">
              {[
                { label: 'Revenue (Subtotal)', value: pnl.revenue, kind: 'positive' },
                { label: 'Discounts', value: pnl.discount, kind: 'deduction' },
                { label: 'Net Sales', value: pnl.netSales, kind: 'subtotal', separator: true },
                { label: 'Cost of Goods Sold', value: pnl.cogs, kind: 'deduction' },
                { label: 'Gross Profit', value: pnl.grossProfit, kind: 'subtotal', separator: true },
                { label: 'Expenses', value: pnl.expenses, kind: 'deduction' },
                { label: isLoss ? 'Net Loss' : 'Net Profit', value: pnl.netProfit, kind: isLoss ? 'negative' : 'positive', total: true },
              ].map((row, i) => {
                const showSeparator = row.separator && i > 0;
                const isNegative = row.kind === 'deduction' || row.kind === 'negative';
                return (
                  <div
                    key={row.label}
                    className={`flex items-center justify-between py-3 px-2 ${
                      row.total
                        ? 'border-t-2 border-[var(--app-border)] pt-4 text-xl font-bold'
                        : row.kind === 'subtotal'
                        ? 'font-bold text-[var(--app-text)]'
                        : 'text-sm text-[var(--app-text-soft)]'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {showSeparator && (
                        <span className="h-px w-8 bg-[var(--app-border)]" />
                      )}
                      <span className={row.total || row.kind === 'subtotal' ? 'font-bold' : 'font-medium'}>
                        {row.label}
                      </span>
                    </div>
                    <span
                      className={`font-mono tabular-nums ${
                        row.total
                          ? isLoss
                            ? 'text-red-600 dark:text-red-400'
                            : isBreakEven
                            ? 'text-[var(--app-text-soft)]'
                            : 'text-indigo-600 dark:text-indigo-400'
                          : isNegative
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-[var(--app-text)]'
                      }`}
                    >
                      {formatCurrency(row.value)}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
          <section className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel-2)] shadow-sm overflow-hidden animate-slide-up" style={{ animationDelay: '500ms', animationFillMode: 'both' }}>
            <div className="p-5 border-b border-[var(--app-border)] bg-[var(--app-panel)] flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-[var(--app-text)]">Top-Selling Products</h2>
                <p className="text-xs text-[var(--app-muted)]">Top 10 by quantity sold — {renderRangeLabel()}</p>
              </div>
              {productsError && (
                <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                  {productsError}
                </span>
              )}
            </div>
            <div className="p-5">
              {pnlError || productsError ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700 mb-3">
                  {pnlError || productsError}
                </div>
              ) : topProducts.length === 0 ? (
                <div className="rounded-2xl border-2 border-dashed border-[var(--app-border)] p-6 text-center">
                  <p className="text-sm font-medium text-[var(--app-muted)]">No products sold in this date range.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[var(--app-border)]">
                        <th className="pb-3 text-xs font-bold text-[var(--app-text-soft)] uppercase tracking-wider">Rank</th>
                        <th className="pb-3 text-xs font-bold text-[var(--app-text-soft)] uppercase tracking-wider">Product Name</th>
                        <th className="pb-3 text-xs font-bold text-[var(--app-text-soft)] uppercase tracking-wider text-right">Quantity Sold</th>
                        <th className="pb-3 text-xs font-bold text-[var(--app-text-soft)] uppercase tracking-wider text-right">Revenue</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--app-border)]">
                      {topProducts.map((product, i) => (
                        <tr
                          key={product.productId}
                          className="group hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors"
                        >
                          <td className="py-3 text-sm font-medium">
                            {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
                          </td>
                          <td className="py-3 text-sm text-[var(--app-text)]">
                            {product.productName || 'Unknown'}
                          </td>
                          <td className="py-3 text-sm text-right text-[var(--app-text)]">
                            {formatCount(product.quantitySold)}
                          </td>
                          <td className="py-3 text-sm text-right text-[var(--app-text)]">
                            {formatCurrency(product.revenue)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {pnlError && !error && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700 mb-3 flex justify-between items-center">
              <span>P&L report failed to load.</span>
              <button
                onClick={() => {
                  setPnlError(null);
                  void fetchReports(false);
                }}
                className="px-4 py-1.5 bg-white dark:bg-slate-800 border border-amber-200 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/20 transition-colors text-sm font-medium text-amber-700 dark:text-amber-400"
              >
                Retry P&L
              </button>
            </div>
          )}
          {productsError && !error && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700 mb-3 flex justify-between items-center">
              <span>Top products failed to load.</span>
              <button
                onClick={() => {
                  setProductsError(null);
                  void fetchReports(false);
                }}
                className="px-4 py-1.5 bg-white dark:bg-slate-800 border border-amber-200 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/20 transition-colors text-sm font-medium text-amber-700 dark:text-amber-400"
              >
                Retry Products
              </button>
            </div>
          )}

          {!loading && !refreshing && !error && !pnlError && !productsError && topProducts.length === 0 && (
            <div className="rounded-2xl border-2 border-dashed border-[var(--app-border)] p-8 text-center">
              <p className="text-sm font-medium text-[var(--app-muted)]">
                No sales in this date range.
              </p>
              <p className="text-sm text-[var(--app-muted)] mt-1">
                Expense and financial values below reflect backend data for this period.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
