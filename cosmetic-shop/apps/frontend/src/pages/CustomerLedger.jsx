import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Loader2,
  RefreshCw,
  ArrowLeft,
  Plus,
  ChevronLeft,
  ChevronRight,
  X,
  CheckCircle,
  AlertCircle,
  Banknote,
  CreditCard,
  Edit2,
} from 'lucide-react';
import {
  fetchCustomer,
  fetchCustomerLedger,
  recordCustomerPayment,
  recordCustomerDebt,
} from '../api/customers';

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

const TYPE_CONFIG = {
  SALE: { label: 'Credit Sale', debit: true, color: 'text-amber-700 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/30', border: 'border-amber-100 dark:border-amber-800' },
  DEBT: { label: 'Manual Debt', debit: true, color: 'text-purple-700 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-900/30', border: 'border-purple-100 dark:border-purple-800' },
  PAYMENT: { label: 'Payment Received', debit: false, color: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/30', border: 'border-emerald-100 dark:border-emerald-800' },
  ADJUSTMENT: { label: 'Manual Adjustment', debit: true, color: 'text-slate-700 dark:text-slate-400', bg: 'bg-slate-50 dark:bg-slate-900/30', border: 'border-slate-100 dark:border-slate-800' },
};

export default function CustomerLedger() {
  const { id } = useParams();
  const navigate = useNavigate();
  const customerId = Number(id);

  const [customer, setCustomer] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentForm, setPaymentForm] = useState({ amount: '', description: '' });
  const [paymentErrors, setPaymentErrors] = useState({});
  const [paying, setPaying] = useState(false);
  const [paymentError, setPaymentError] = useState(null);

  const [debtOpen, setDebtOpen] = useState(false);
  const [debtForm, setDebtForm] = useState({ amount: '', description: '' });
  const [debtErrors, setDebtErrors] = useState({});
  const [recordingDebt, setRecordingDebt] = useState(false);
  const [debtError, setDebtError] = useState(null);

  const requestSeqRef = useRef(0);
  const mounted = useRef(true);
  const fetchCustomerData = useCallback(async () => {
    setError(null);
    try {
      const data = await fetchCustomer(customerId);
      setCustomer(data);
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Failed to load customer.');
    }
  }, [customerId]);

  const fetchLedger = useCallback(
    async (currentPage, isRefresh = false) => {
      const requestSeq = ++requestSeqRef.current;
      if (!isRefresh) setLoading(true);
      else setRefreshing(true);
      setError(null);

      try {
        const data = await fetchCustomerLedger(customerId, {
          page: currentPage,
          limit,
        });
        if (!mounted.current || requestSeq !== requestSeqRef.current) return;
        setTransactions(Array.isArray(data.transactions) ? data.transactions : []);
        setTotal(data.total);
        setPage(data.page);
        setLimit(data.limit);
        setTotalPages(data.totalPages);
      } catch (err) {
        if (!mounted.current || requestSeq !== requestSeqRef.current) return;
        setError(err?.message || 'Failed to load ledger.');
      } finally {
        if (!mounted.current || requestSeq === requestSeqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [customerId, limit, mounted]
  );

  useEffect(() => {
    mounted.current = true;
    void fetchCustomerData();
    void fetchLedger(page, false);
    return () => {
      mounted.current = false;
    };
  }, [fetchCustomerData, fetchLedger, page]);

  const handleRefresh = () => {
    requestSeqRef.current += 1;
    void fetchCustomerData();
    void fetchLedger(page, true);
  };

  const runningBalance = useMemo(() => {
    let balance = Number(customer?.balance ?? 0);
    const ordered = [...transactions].reverse();
    return ordered.map((tx) => {
      const before = balance;
      const amount = Number(tx.amount ?? 0);
      if (tx.type === 'PAYMENT') balance -= amount;
      else balance += amount;
      return { ...tx, before, after: balance };
    });
  }, [transactions, customer?.balance]);

  const handleOpenPayment = () => {
    setPaymentForm({ amount: '', description: '' });
    setPaymentErrors({});
    setPaymentError(null);
    setPaymentOpen(true);
  };

  const handleClosePayment = () => {
    setPaymentOpen(false);
    setPaymentForm({ amount: '', description: '' });
    setPaymentErrors({});
    setPaymentError(null);
  };

  const validatePayment = () => {
    const errors = {};
    const amountNum = Number(paymentForm.amount);
    const balance = Number(customer?.balance ?? 0);
    if (paymentForm.amount === '' || paymentForm.amount == null)
      errors.amount = 'Amount is required.';
    else if (!Number.isFinite(amountNum) || amountNum <= 0)
      errors.amount = 'Amount must be greater than zero.';
    else if (balance <= 0)
      errors.amount = 'No outstanding balance to pay.';
    else if (amountNum > balance)
      errors.amount = `Payment exceeds outstanding balance (${formatCurrency(balance)}).`;
    else if (amountNum > 1e9)
      errors.amount = 'Amount must not exceed 1000000000.';
    return errors;
  };

  const handlePaymentSubmit = async (e) => {
    e.preventDefault();
    const errors = validatePayment();
    if (Object.keys(errors).length > 0) {
      setPaymentErrors(errors);
      return;
    }
    setPaymentErrors({});
    setPaymentError(null);
    setPaying(true);

    try {
      const result = await recordCustomerPayment(customerId, {
        amount: paymentForm.amount,
        description: paymentForm.description || null,
      });
      setPaying(false);
      setPaymentOpen(false);
      setPaymentForm({ amount: '', description: '' });
      setSuccessMessage(
        `Payment of ${formatCurrency(
          Number(paymentForm.amount)
        )} recorded for ${result.customer.name}.`
      );
      requestSeqRef.current += 1;
      void fetchCustomerData();
      void fetchLedger(page, false);
    } catch (err) {
      setPaying(false);
      setPaymentError(
        err.response?.data?.error?.message || 'Failed to record payment.'
      );
    }
  };

  const dismissSuccess = () => setSuccessMessage(null);

  const handleOpenDebt = () => {
    setDebtForm({ amount: '', description: '' });
    setDebtErrors({});
    setDebtError(null);
    setDebtOpen(true);
  };

  const handleCloseDebt = () => {
    setDebtOpen(false);
    setDebtForm({ amount: '', description: '' });
    setDebtErrors({});
    setDebtError(null);
  };

  const validateDebt = () => {
    const errors = {};
    const amountNum = Number(debtForm.amount);
    if (debtForm.amount === '' || debtForm.amount == null)
      errors.amount = 'Amount is required.';
    else if (!Number.isFinite(amountNum) || amountNum <= 0)
      errors.amount = 'Amount must be greater than zero.';
    else if (amountNum > 1e9)
      errors.amount = 'Amount must not exceed 1000000000.';
    if (debtForm.description === '' || !debtForm.description.trim())
      errors.description = 'Description is required.';
    return errors;
  };

  const handleDebtSubmit = async (e) => {
    e.preventDefault();
    const errors = validateDebt();
    if (Object.keys(errors).length > 0) {
      setDebtErrors(errors);
      return;
    }
    setDebtErrors({});
    setDebtError(null);
    setRecordingDebt(true);

    try {
      const result = await recordCustomerDebt(customerId, {
        amount: debtForm.amount,
        description: debtForm.description,
      });
      setRecordingDebt(false);
      setDebtOpen(false);
      setDebtForm({ amount: '', description: '' });
      setSuccessMessage(
        `Debt of ${formatCurrency(Number(debtForm.amount))} recorded for ${result.customer.name}.`
      );
      requestSeqRef.current += 1;
      void fetchCustomerData();
      void fetchLedger(page, false);
    } catch (err) {
      setRecordingDebt(false);
      setDebtError(
        err.response?.data?.error?.message || 'Failed to record debt entry.'
      );
    }
  };


  if (!customer) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-slate-500">
        <Loader2 className="h-8 w-8 animate-spin mb-3" />
        <p>Loading customer ledger...</p>
      </div>
    );
  }

  const owesAmount = Math.max(Number(customer.balance ?? 0), 0);
  const hasOutstanding = owesAmount > 0;

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
            {customer.name}
          </h2>
          <p className="text-sm text-[var(--app-muted)]">
            Udhaar history for {customer.name}
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
            Refresh
          </button>
          <button
            type="button"
            onClick={handleOpenPayment}
            disabled={paying || !hasOutstanding}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--app-accent)] px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:brightness-105 disabled:opacity-70"
          >
            <Plus className="h-4 w-4" /> Record Payment Received
          </button>
          {customer.type !== 'RETAIL' && (
            <button
              type="button"
              onClick={handleOpenDebt}
              disabled={recordingDebt}
              className="inline-flex items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-4 py-2.5 text-sm font-bold text-[var(--app-text)] shadow-sm transition hover:bg-[var(--app-panel)] disabled:opacity-70"
            >
              <Edit2 className="h-4 w-4" /> Record Debt
            </button>
          )}
        </div>
      </div>

      {successMessage && (
        <div
          className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-700 flex items-center gap-2 animate-slide-in"
          role="status"
        >
          <CheckCircle className="h-4 w-4" />
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
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6">
          <div>
            <p className="text-sm text-[var(--app-text-soft)]">Name</p>
            <p className="text-lg font-bold text-[var(--app-text)]">
              {customer.name}
            </p>
            {customer.phone && (
              <p className="text-sm text-[var(--app-muted)] mt-1">{customer.phone}</p>
            )}
            {customer.email && (
              <p className="text-sm text-[var(--app-muted)]">{customer.email}</p>
            )}
            {customer.address && (
              <p className="text-sm text-[var(--app-muted)]">{customer.address}</p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <p className="text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider">
              Current Udhaar
            </p>
            <p
              className={`text-3xl font-bold ${
                hasOutstanding
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-slate-700 dark:text-slate-400'
              }`}
            >
              {formatCurrency(owesAmount)}
            </p>
            <p className="text-xs text-[var(--app-muted)]">
              {Number(customer.balance ?? 0) < 0
                ? 'Advance / Paid Ahead'
                : hasOutstanding
                  ? 'This person owes you this amount'
                  : 'No outstanding amount'}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)]/50 p-4">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="font-semibold text-[var(--app-muted)] uppercase">Type</span>
            <span className="font-semibold text-[var(--app-muted)] uppercase text-right">Amount</span>
          </div>
          <div className="flex items-center justify-between pt-2 border-t border-[var(--app-border)] text-sm">
            <span className="text-[var(--app-text-soft)]">Ledger entries</span>
            <span className="font-medium text-[var(--app-text)]">
              {transactions.length}
            </span>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[var(--app-border)]">
              <th className="px-5 py-3.5 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider bg-[var(--app-panel-2)]/50">
                Type
              </th>
              <th className="px-5 py-3.5 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider bg-[var(--app-panel-2)]/50 text-right">
                Amount
              </th>
              <th className="px-5 py-3.5 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider bg-[var(--app-panel-2)]/50">
                Description
              </th>
              <th className="px-5 py-3.5 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider bg-[var(--app-panel-2)]/50">
                Sale
              </th>
            </tr>
          </thead>
          <tbody>
            {transactions.length === 0 && (
              <tr>
                <td colSpan="4" className="px-5 py-12 text-center">
                  {loading ? (
                    <div className="flex flex-col items-center justify-center gap-2 text-[var(--app-muted)]">
                      <Loader2 className="h-6 w-6 animate-spin" />
                      <p>Loading ledger...</p>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-3">
                      <Banknote className="h-8 w-8 text-[var(--app-muted)]" />
                      <p className="text-sm text-[var(--app-muted)]">
                        No ledger transactions yet.
                      </p>
                    </div>
                  )}
                </td>
              </tr>
            )}
            {transactions.map((tx) => {
              const typeConfig = TYPE_CONFIG[tx.type] || TYPE_CONFIG.ADJUSTMENT;
              const amount = Number(tx.amount ?? 0);
              const isPayment = tx.type === 'PAYMENT';
              const productName = tx.description || 'Manual entry';
              return (
                <tr
                  key={tx.id}
                  className="border-b border-[var(--app-border)]/50 hover:bg-[var(--app-panel-2)]/30 transition-colors"
                >
                  <td className="px-5 py-4">
                    <div>
                      <p className="text-sm font-medium text-[var(--app-text)]">
                        {typeConfig.label}
                        <span
                          className={`text-xs font-bold px-2 py-0.5 rounded-full border ${
                            typeConfig.bg.split(' ')[0]
                          } ${typeConfig.color.split(' ')[0]} ${typeConfig.border.split(' ')[0]}`}
                        >
                          {tx.type}
                        </span>
                      </p>
                      <p className="text-xs text-[var(--app-muted)]">{formatDate(tx.createdAt)}</p>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-right">
                    <span
                      className={`text-sm font-bold ${
                        isPayment
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-amber-700 dark:text-amber-400'
                      }`}
                    >
                      {isPayment ? '-' : '+'}{formatCurrency(amount)}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    <p className="text-sm text-[var(--app-text)]">{productName}</p>
                  </td>
                  <td className="px-5 py-4">
                    {tx.saleId ? (
                      <span className="text-sm font-medium text-[var(--app-text)]">
                        Sale #{tx.saleId}
                      </span>
                    ) : (
                      <span className="text-sm text-[var(--app-text-soft)]">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-[var(--app-muted)]">
            Showing page {page} of {totalPages} ({total} transactions)
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1 || loading}
              className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm font-medium text-[var(--app-text)] transition disabled:opacity-50 disabled:pointer-events-none"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages || loading}
              className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm font-medium text-[var(--app-text)] transition disabled:opacity-50 disabled:pointer-events-none"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {paymentOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
            onClick={handleClosePayment}
          />
          <div className="relative w-full max-w-md rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in">
            <div className="flex items-center gap-2 mb-6">
              <CreditCard className="h-5 w-5 text-emerald-600" />
              <h3 className="text-xl font-extrabold text-[var(--app-text)]">
                Record Payment Received
              </h3>
            </div>
            <p className="text-sm text-[var(--app-muted)] mb-4">
              Record a payment received from <strong>{customer.name}</strong>.
              The payment cannot exceed the outstanding balance of{' '}
              {formatCurrency(Number(customer.balance ?? 0))}.
            </p>

            <form onSubmit={handlePaymentSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">
                  Amount (Rs.)
                </label>
                <input
                  type="number"
                  min="0"
                  max={Number(customer.balance ?? 0)}
                  step="0.01"
                  value={paymentForm.amount}
                  onChange={(e) =>
                    setPaymentForm({ ...paymentForm, amount: e.target.value })
                  }
                  className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]"
                  placeholder="0.00"
                />
                {paymentErrors.amount && (
                  <p className="mt-1 text-xs font-medium text-red-600">
                    {paymentErrors.amount}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">
                  Description
                </label>
                <input
                  type="text"
                  value={paymentForm.description}
                  onChange={(e) =>
                    setPaymentForm({ ...paymentForm, description: e.target.value })
                  }
                  className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]"
                  placeholder="e.g., Paid cash, Bank transfer, etc."
                />
              </div>

              {paymentError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                  {paymentError}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleClosePayment}
                  disabled={paying}
                  className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-4 py-2.5 text-sm font-bold text-[var(--app-text)] transition hover:bg-[var(--app-panel)] disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={paying}
                  className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-70"
                >
                  {paying ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Recording...
                    </>
                  ) : (
                    <>
                      <Plus className="h-4 w-4" />
                      Record Payment Received
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {debtOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
            onClick={handleCloseDebt}
          />
          <div className="relative w-full max-w-md rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in">
            <div className="flex items-center gap-2 mb-6">
              <Banknote className="h-5 w-5 text-purple-600" />
              <h3 className="text-xl font-extrabold text-[var(--app-text)]">
                Record Manual Debt
              </h3>
            </div>
            <p className="text-sm text-[var(--app-text-soft)] mb-6">
              Records an amount owed by <strong>{customer.name}</strong>. This does not
              create a product sale or change inventory.
            </p>
            <form onSubmit={handleDebtSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">
                  Amount Owed (Rs.)
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={debtForm.amount}
                  onChange={(e) =>
                    setDebtForm({ ...debtForm, amount: e.target.value })
                  }
                  className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]"
                  placeholder="0.00"
                />
                {debtErrors.amount && (
                  <p className="mt-1 text-xs font-medium text-red-600">
                    {debtErrors.amount}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">
                  Description / Reason
                </label>
                <input
                  type="text"
                  value={debtForm.description}
                  onChange={(e) =>
                    setDebtForm({ ...debtForm, description: e.target.value })
                  }
                  className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]"
                  placeholder="e.g., Supply of goods, Service charge, etc."
                />
                {debtErrors.description && (
                  <p className="mt-1 text-xs font-medium text-red-600">
                    {debtErrors.description}
                  </p>
                )}
              </div>

              {debtError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                  {debtError}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleCloseDebt}
                  disabled={recordingDebt}
                  className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-4 py-2.5 text-sm font-bold text-[var(--app-text)] transition hover:bg-[var(--app-panel)] disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={recordingDebt}
                  className="inline-flex items-center gap-2 rounded-xl bg-purple-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-purple-700 disabled:opacity-70"
                >
                  {recordingDebt ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Recording...
                    </>
                  ) : (
                    <>
                      <Plus className="h-4 w-4" /> Record Debt Entry
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

