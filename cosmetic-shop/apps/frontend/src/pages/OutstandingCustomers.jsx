import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  Loader2,
  RefreshCw,
  ArrowLeft,
  Banknote,
  X,
  AlertCircle,
  User,
} from 'lucide-react';
import { fetchOutstandingCustomers } from '../api/customers';

const formatCurrency = (value) => {
  if (value === null || value === undefined || value === '') return 'Rs. 0';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'Rs. 0';
  return `Rs. ${numeric.toLocaleString('en-PK', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
};

const formatDate = (value) => {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
};

export default function OutstandingCustomers() {
  const navigate = useNavigate();

  const [customers, setCustomers] = useState([]);
  const [totalOutstanding, setTotalOutstanding] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  const requestSeqRef = useRef(0);

  const fetchOutstanding = useCallback(async (isRefresh = false) => {
    const requestSeq = ++requestSeqRef.current;
    if (!isRefresh) setLoading(true);
    else setRefreshing(true);
    setError(null);

    try {
      const data = await fetchOutstandingCustomers();
      if (requestSeq !== requestSeqRef.current) return;
      setCustomers(Array.isArray(data.customers) ? data.customers : []);
      setTotalOutstanding(Number(data.totalOutstanding ?? 0));
    } catch (err) {
      if (requestSeq !== requestSeqRef.current) return;
      setError(err?.message || 'Failed to load outstanding customers.');
    } finally {
      if (requestSeq === requestSeqRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void fetchOutstanding(false);
  }, [fetchOutstanding]);

  const handleRefresh = () => {
    requestSeqRef.current += 1;
    void fetchOutstanding(true);
  };

  const dismissSuccess = () => setSuccessMessage(null);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={() => navigate('/customers')}
            className="inline-flex items-center gap-2 text-sm font-medium text-[var(--app-text-soft)] hover:text-indigo-600 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Back to People / Udhaar
          </button>
          <h2 className="text-2xl font-extrabold text-[var(--app-text)] mt-3 md:mt-0">
            Outstanding Udhaar
          </h2>
          <p className="text-sm text-[var(--app-muted)]">
            Everyone who owes you money
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-2.5 text-sm font-medium text-[var(--app-text)] transition hover:bg-[var(--app-panel-2)] disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {successMessage && (
        <div
          className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-700 flex items-center gap-2 animate-slide-in"
          role="status"
        >
          <X className="h-4 w-4" />{" "}
          {successMessage}
          <button
            type="button"
            onClick={dismissSuccess}
            className="ml-auto text-[var(--app-muted)] hover:text-green-600 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-auto text-[var(--app-muted)] hover:text-red-600 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div className="flex flex-col">
            <p className="text-sm font-semibold text-[var(--app-muted)] uppercase tracking-wider">
              Total Udhaar Owed
            </p>
            <p className="text-3xl font-bold text-amber-700 dark:text-amber-400">
              {formatCurrency(totalOutstanding)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="px-3 py-1 rounded-full bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-xs font-semibold border border-amber-100 dark:border-amber-800">
              {customers.length} person{customers.length !== 1 ? 's' : ''}
              owed
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[var(--app-border)]">
              <th className="px-5 py-3.5 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider bg-[var(--app-panel-2)]/50">
                Person
              </th>
              <th className="px-5 py-3.5 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider bg-[var(--app-panel-2)]/50">
                Phone
              </th>
              <th className="px-5 py-3.5 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider bg-[var(--app-panel-2)]/50 text-right">
                Udhaar Amount
              </th>
              <th className="px-5 py-3.5 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider bg-[var(--app-panel-2)]/50">
                Created
              </th>
              <th className="px-5 py-3.5 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider bg-[var(--app-panel-2)]/50">
                Ledger
              </th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 && (
              <tr>
                <td colSpan="5" className="px-5 py-12 text-center">
                  {loading ? (
                    <div className="flex flex-col items-center justify-center gap-2 text-[var(--app-muted)]">
                      <Loader2 className="h-6 w-6 animate-spin" />
                      <p>Loading outstanding customers...</p>
                    </div>
                  ) : error ? (
                    <p className="text-sm text-red-600">
                      {error}. Click Refresh to retry.
                    </p>
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-3">
                      <User className="h-8 w-8 text-[var(--app-muted)]" />
                      <p className="text-sm text-[var(--app-muted)]">
                        No one owes you money right now.
                      </p>
                    </div>
                  )}
                </td>
              </tr>
            )}
            {customers.map((customer) => (
              <tr
                key={customer.id}
                className="border-b border-[var(--app-border)]/50 hover:bg-[var(--app-panel-2)]/30 transition-colors"
              >
                <td className="px-5 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900 flex items-center justify-center text-indigo-700 dark:text-indigo-300 font-bold text-sm">
                      {customer.name?.charAt(0)?.toUpperCase() || '?'}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[var(--app-text)]">
                        {customer.name}
                      </p>
                      <p className="text-xs text-[var(--app-muted)]">
                        #{customer.id}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-4">
                  <p className="text-sm text-[var(--app-text)]">
                    {customer.phone || '-'}
                  </p>
                </td>
                <td className="px-5 py-4 text-right">
                  <span className="text-sm font-bold text-amber-700 dark:text-amber-400">
                    {formatCurrency(customer.balance)}
                  </span>
                </td>
                <td className="px-5 py-4">
                  <p className="text-sm text-[var(--app-text-soft)]">
                    {formatDate(customer.createdAt)}
                  </p>
                </td>
                <td className="px-5 py-4">
                  <Link
                    to={`/customers/${customer.id}`}
                    className="inline-flex items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm font-medium text-[var(--app-text)] transition hover:bg-[var(--app-panel-2)]"
                  >
                    View Ledger <Banknote className="h-4 w-4" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

