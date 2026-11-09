import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Calendar,
  DollarSign,
  Factory,
  RefreshCw,
  ReceiptText,
  TrendingDown,
  TrendingUp,
  Sparkles,
  ArrowRight,
} from 'lucide-react';
import { fetchPnlReport, fetchTopProducts } from '../api/reports';

// --- Date Helpers ---
function toUtcDateString(date) {
  return (
    date.getUTCFullYear() + '-' +
    String(date.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(date.getUTCDate()).padStart(2, '0')
  );
}

function getTodayUtcString() { return toUtcDateString(new Date()); }

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
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

function validateCustomRange(from, to) {
  if (!from || !to) return { valid: false, error: 'Both dates are required.' };
  if (!isValidDateString(from)) return { valid: false, error: 'Invalid From date.' };
  if (!isValidDateString(to)) return { valid: false, error: 'Invalid To date.' };
  if (from > to) return { valid: false, error: 'From date must not be after To date.' };
  return { valid: true, error: null };
}

// --- Formatters ---
function formatCurrency(value) {
  if (value === null || value === undefined || value === '') return 'N/A';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  return `Rs. ${numeric.toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function formatCount(value) {
  if (value === null || value === undefined || value === '') return 'N/A';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  return numeric.toLocaleString('en-PK');
}

const PRESETS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This Week' },
  { id: 'month', label: 'This Month' },
  { id: 'custom', label: 'Custom' },
];

const getInitialPnl = () => ({
  revenue: null, discount: null, netSales: null, cogs: null, grossProfit: null, expenses: null, netProfit: null,
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

  const requestIdRef = useRef(0);
  const busyRef = useRef(false);

  const today = getTodayUtcString();
  const monday = getMondayOfWeekUtcString();
  const firstOfMonth = getFirstDayOfMonthUtcString();

  const selectedFrom = preset === 'today' ? today : preset === 'week' ? monday : preset === 'month' ? firstOfMonth : customFrom;
  const selectedTo = preset === 'today' ? today : preset === 'week' ? today : preset === 'month' ? today : customTo;

  const { valid: customValid, error: customValidationError } = validateCustomRange(selectedFrom, selectedTo);
  const canFetch = preset !== 'custom' || customValid;

  const fetchReports = useCallback(async (isRefresh = false) => {
    if (!canFetch || busyRef.current) return;
    const requestId = ++requestIdRef.current;
    busyRef.current = true;

    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError(null); setPnlError(null); setProductsError(null);

    try {
      const results = await Promise.allSettled([
        fetchPnlReport(selectedFrom, selectedTo),
        fetchTopProducts(selectedFrom, selectedTo, 10),
      ]);

      if (requestId !== requestIdRef.current) return;

      if (results[0].status === 'fulfilled') { setPnl(results[0].value); setPnlError(null); }
      else setPnlError('Failed to load P&L report.');

      if (results[1].status === 'fulfilled') { setTopProducts(results[1].value); setProductsError(null); }
      else setProductsError('Failed to load top products.');

    } catch (err) {
      if (requestId === requestIdRef.current) setError('An unexpected error occurred.');
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false); setRefreshing(false); busyRef.current = false;
      }
    }
  }, [selectedFrom, selectedTo, canFetch]);

  useEffect(() => {
    fetchReports(false);
    return () => { requestIdRef.current += 1; busyRef.current = false; };
  }, [fetchReports]);

  const handleRefresh = () => void fetchReports(true);

  const handlePresetChange = (id) => {
    setPreset(id);
    if (id === 'today') { setCustomFrom(today); setCustomTo(today); }
    else if (id === 'week') { setCustomFrom(monday); setCustomTo(today); }
    else if (id === 'month') { setCustomFrom(firstOfMonth); setCustomTo(today); }
  };

  const netProfit = pnl.netProfit;
  const isLoss = typeof netProfit === 'number' && netProfit < 0;
  const isBreakEven = typeof netProfit === 'number' && netProfit === 0;

  const statCards = [
    { label: 'Revenue', value: pnl.revenue, format: formatCurrency, color: 'text-emerald-600', bg: 'bg-emerald-100', gradient: 'from-emerald-400 to-teal-500', border: 'border-slate-200', Icon: DollarSign },
    { label: 'Cost of Goods', value: pnl.cogs, format: formatCurrency, color: 'text-amber-600', bg: 'bg-amber-100', gradient: 'from-amber-400 to-orange-500', border: 'border-slate-200', Icon: Factory },
    { label: 'Expenses', value: pnl.expenses, format: formatCurrency, color: 'text-orange-600', bg: 'bg-orange-100', gradient: 'from-orange-400 to-red-500', border: 'border-slate-200', Icon: ReceiptText },
    { label: isLoss ? 'Net Loss' : 'Net Profit', value: pnl.netProfit, format: formatCurrency, color: isLoss ? 'text-red-600' : 'text-indigo-600', bg: isLoss ? 'bg-red-100' : 'bg-indigo-100', gradient: isLoss ? 'from-red-400 to-red-600' : 'from-indigo-400 to-purple-500', border: isLoss ? 'border-slate-200' : 'border-slate-200', Icon: isLoss ? TrendingDown : TrendingUp },
  ];

  return (
    <div className="space-y-8 animate-fade-in max-w-7xl mx-auto rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-[0_16px_40px_rgba(15,23,42,0.08)] sm:p-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="p-2 rounded-xl bg-indigo-100 text-indigo-600">
              <Sparkles className="h-5 w-5" />
            </div>
            <span className="text-xs font-bold text-indigo-600 uppercase tracking-widest">Analytics</span>
          </div>
          <h1 className="text-3xl font-extrabold text-[var(--app-text)] tracking-tight">Reports & P&L</h1>
          <p className="mt-1 text-sm text-[var(--app-muted)] font-medium">Analyze your shop's financial performance.</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading || refreshing || !canFetch}
          className="inline-flex items-center gap-2 rounded-xl bg-[var(--app-panel-2)] border border-[var(--app-border)] px-5 py-2.5 text-sm font-bold text-[var(--app-text)] shadow-sm hover:bg-[var(--app-panel)] transition-all disabled:opacity-70"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin text-indigo-500' : 'text-[var(--app-muted)]'}`} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel-2)] p-2 shadow-sm flex flex-col sm:flex-row gap-2">
        <div className="flex flex-1 bg-[var(--app-panel)] rounded-2xl p-1">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => handlePresetChange(p.id)}
              className={`flex-1 px-4 py-2 text-sm font-bold rounded-xl transition-all ${
                preset === p.id
                  ? 'bg-[var(--app-panel)] text-indigo-600 shadow-sm ring-1 ring-[var(--app-border)]'
                  : 'text-[var(--app-muted)] hover:text-[var(--app-text)]'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="flex items-center gap-2 px-2">
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="px-3 py-2 bg-[var(--app-panel)] border border-[var(--app-border)] rounded-xl text-sm text-[var(--app-text)] outline-none focus:ring-2 focus:ring-indigo-500" />
            <ArrowRight className="h-4 w-4 text-[var(--app-muted)]" />
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="px-3 py-2 bg-[var(--app-panel)] border border-[var(--app-border)] rounded-xl text-sm text-[var(--app-text)] outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
        )}
      </div>

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

      <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-sm overflow-hidden animate-slide-up" style={{ animationDelay: '400ms', animationFillMode: 'both' }}>
        <div className="p-5 border-b border-[var(--app-border)] bg-[var(--app-panel-2)] flex items-center gap-3">
          <div className="p-2 bg-indigo-100 rounded-xl text-indigo-600">
            <Calendar className="h-5 w-5" />
          </div>
          <h2 className="text-lg font-bold text-[var(--app-text)]">Profit & Loss Statement</h2>
        </div>
        
        <div className="p-6">
          <div className="space-y-4 max-w-2xl mx-auto">
            <div className="flex justify-between items-center text-sm">
              <span className="text-[var(--app-muted)] font-medium">Revenue (Subtotal)</span>
              <span className="font-bold text-[var(--app-text)] font-mono">{formatCurrency(pnl.revenue)}</span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-[var(--app-muted)] font-medium">Discounts</span>
              <span className="font-bold text-amber-600 font-mono">- {formatCurrency(pnl.discount)}</span>
            </div>
            <div className="flex justify-between items-center py-3 border-y border-[var(--app-border)]">
              <span className="text-[var(--app-text)] font-bold">Net Sales</span>
              <span className="font-bold text-[var(--app-text)] font-mono">{formatCurrency(pnl.netSales)}</span>
            </div>
            
            <div className="flex justify-between items-center text-sm pt-2">
              <span className="text-[var(--app-text-soft)] font-medium">Cost of Goods Sold</span>
              <span className="font-bold text-amber-600 font-mono">- {formatCurrency(pnl.cogs)}</span>
            </div>
            <div className="flex justify-between items-center py-3 border-y border-[var(--app-border)]">
              <span className="text-[var(--app-text)] font-bold">Gross Profit</span>
              <span className="font-bold text-[var(--app-text)] font-mono">{formatCurrency(pnl.grossProfit)}</span>
            </div>

            <div className="flex justify-between items-center text-sm pt-2">
              <span className="text-[var(--app-text-soft)] font-medium">Operating Expenses</span>
              <span className="font-bold text-amber-600 font-mono">- {formatCurrency(pnl.expenses)}</span>
            </div>
            <div className={`flex justify-between items-center p-4 rounded-2xl border ${
              isLoss 
                ? 'bg-red-50 border-red-200' 
                : 'bg-indigo-50 border-indigo-200'
            }`}>
              <span className={`font-extrabold text-lg ${isLoss ? 'text-red-700' : 'text-indigo-700'}`}>
                {isLoss ? 'Net Loss' : 'Net Profit'}
              </span>
              <span className={`font-extrabold text-2xl font-mono ${isLoss ? 'text-red-700' : 'text-indigo-700'}`}>
                {formatCurrency(pnl.netProfit)}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-sm overflow-hidden animate-slide-up" style={{ animationDelay: '500ms', animationFillMode: 'both' }}>
        <div className="p-5 border-b border-[var(--app-border)] bg-[var(--app-panel-2)] flex items-center justify-between">
          <h2 className="text-lg font-bold text-[var(--app-text)]">Top Selling Products</h2>
          <span className="text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider">Top 10</span>
        </div>
        
        {topProducts.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm text-[var(--app-muted)]">No products sold in this date range.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[var(--app-border)] bg-[var(--app-panel-2)]">
                  <th className="px-6 py-4 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider w-20">Rank</th>
                  <th className="px-6 py-4 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider">Product</th>
                  <th className="px-6 py-4 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider text-right">Qty Sold</th>
                  <th className="px-6 py-4 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider text-right">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--app-border)]">
                {topProducts.map((product, i) => (
                  <tr key={product.productId} className="hover:bg-[var(--app-panel-2)] transition-colors">
                    <td className="px-6 py-4 text-lg">
                      {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : <span className="text-sm font-bold text-[var(--app-muted)] ml-2">{i + 1}</span>}
                    </td>
                    <td className="px-6 py-4 font-bold text-[var(--app-text)]">
                      {product.productName || 'Unknown'}
                    </td>
                    <td className="px-6 py-4 text-right font-medium text-[var(--app-text-soft)]">
                      {formatCount(product.quantitySold)}
                    </td>
                    <td className="px-6 py-4 text-right font-bold text-indigo-600">
                      {formatCurrency(product.revenue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}