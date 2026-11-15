import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
  Receipt,
  Wallet,
  TrendingUp,
  TrendingDown,
  Calendar,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import {
  fetchCustomer,
  fetchCustomerLedger,
  recordCustomerPayment,
  recordCustomerDebt,
  buildCustomerPaymentPayload,
  buildCustomerDebtPayload,
} from '../api/customers';
import { computeRunningBalances, computePageAnchor, netBalanceEffect } from '../utils/ledger.js';
import { useMoneyOperation } from '../hooks/useMoneyOperation.js';
import { useUnresolvedOperations } from '../hooks/useUnresolvedOperations.js';
import { MONEY_OUTCOME } from '../utils/moneyOperation.js';
import UnresolvedOperationNotice from '../components/UnresolvedOperationNotice.jsx';
import UnresolvedOperationsBanner from '../components/UnresolvedOperationsBanner.jsx';

/**
 * Send a customer payment. The body is put on the wire unchanged; the
 * customer id comes from the entity that is stored with the operation.
 */
const sendCustomerPayment = (body, key, entity) => recordCustomerPayment(Number(entity), body, key);

/**
 * Send a manual debt entry. The body is put on the wire unchanged; the
 * customer id comes from the entity that is stored with the operation.
 */
const sendCustomerDebt = (body, key, entity) => recordCustomerDebt(Number(entity), body, key);

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
  SALE:       { label: 'Credit Sale',       icon: Receipt,     debit: true,  accent: 'text-amber-600 dark:text-amber-400',   ring: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  DEBT:       { label: 'Manual Debt',       icon: TrendingUp,  debit: true,  accent: 'text-purple-600 dark:text-purple-400', ring: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' },
  PAYMENT:    { label: 'Payment Received',  icon: Banknote,    debit: false, accent: 'text-emerald-600 dark:text-emerald-400', ring: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  ADJUSTMENT: { label: 'Manual Adjustment', icon: Wallet,      debit: true,  accent: 'text-slate-600 dark:text-slate-400',   ring: 'bg-slate-100 text-slate-700 dark:bg-slate-900/40 dark:text-slate-300' },
};

/* ------------------------------------------------------------------ */
/* Small presentational primitives                                     */
/* ------------------------------------------------------------------ */

function StatCard({ icon: Icon, label, value, tone = 'default', hint }) {
  const toneMap = {
    default: 'bg-[var(--app-panel)] border-[var(--app-border)] text-[var(--app-text)]',
    amber:   'bg-amber-50/60 dark:bg-amber-900/10 border-amber-100 dark:border-amber-900/40 text-amber-800 dark:text-amber-300',
    emerald: 'bg-emerald-50/60 dark:bg-emerald-900/10 border-emerald-100 dark:border-emerald-900/40 text-emerald-800 dark:text-emerald-300',
  };
  return (
    <div className={`rounded-2xl border p-4 ${toneMap[tone]}`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider opacity-70">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className="mt-2 text-2xl font-extrabold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs opacity-70">{hint}</p>}
    </div>
  );
}

function ModalShell({ open, onClose, icon: Icon, title, description, tone = 'emerald', children }) {
  if (!open) return null;
  const toneMap = {
    emerald: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30',
    purple:  'text-purple-600 bg-purple-50 dark:bg-purple-900/30',
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-md animate-fade-in" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in">
        <div className="flex items-start gap-3 mb-5">
          <span className={`inline-flex h-10 w-10 items-center justify-center rounded-2xl ${toneMap[tone]}`}>
            <Icon className="h-5 w-5" />
          </span>
          <div className="flex-1">
            <h3 className="text-lg font-extrabold text-[var(--app-text)]">{title}</h3>
            {description && <p className="text-sm text-[var(--app-muted)] mt-1">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--app-muted)] hover:bg-[var(--app-panel-2)] transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, error, children }) {
  return (
    <div>
      <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)] mb-1.5">
        {label}
      </label>
      {children}
      {error && <p className="mt-1.5 text-xs font-medium text-red-600">{error}</p>}
    </div>
  );
}

const inputClass =
  'w-full px-4 py-2.5 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none transition focus:border-[var(--app-accent)] focus:ring-2 focus:ring-[var(--app-accent)]/20';

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

export default function CustomerLedger() {
  const { id } = useParams();
  const navigate = useNavigate();
  const customerId = Number(id);

  const [customer, setCustomer] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [ledgerAnchor, setLedgerAnchor] = useState(null);
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
  const customerRequestRef = useRef(null);
  const ledgerCacheRef = useRef(new Map());

  // One operation per money operation, so a payment and a manual debt entry
  // can never share a key. The scope contains the customer id, so the
  // unresolved state is also visible on the People / Udhaar page, which
  // records a manual debt for the same customer.
  const paymentOperation = useMoneyOperation({
    scope: `customer-payment:${customerId}`,
    operation: 'POST /customers/:id/payment',
    label: 'payment',
    send: sendCustomerPayment,
  });
  const debtOperation = useMoneyOperation({
    scope: `customer-debt:${customerId}`,
    operation: 'POST /customers/:id/debt',
    label: 'debt entry',
    send: sendCustomerDebt,
  });
  const paymentLocked = paymentOperation.locked;
  const debtLocked = debtOperation.locked;

  // The same warning at the page level: an unresolved operation must stay
  // visible even when the dialog is closed.
  const unresolvedPayments = useUnresolvedOperations({
    workflow: 'customer-payment',
    operation: 'POST /customers/:id/payment',
    label: 'payment',
    send: sendCustomerPayment,
    entity: customerId,
  });
  const unresolvedDebts = useUnresolvedOperations({
    workflow: 'customer-debt',
    operation: 'POST /customers/:id/debt',
    label: 'debt entry',
    send: sendCustomerDebt,
    entity: customerId,
  });

  // One shared customer request: the ledger needs `customer.balance` as the
  // anchor of the running balance, and the page needs the whole customer row.
  const requestCustomer = useCallback(() => {
    const pending = customerRequestRef.current;
    if (pending && pending.customerId === customerId) return pending.promise;

    const entry = { customerId, promise: null };
    entry.promise = fetchCustomer(customerId)
      .then((data) => data)
      .catch((err) => {
        // Allow a retry, but only clear our own entry.
        if (customerRequestRef.current === entry) customerRequestRef.current = null;
        throw err;
      });
    customerRequestRef.current = entry;
    return entry.promise;
  }, [customerId]);

  const fetchCustomerData = useCallback(async () => {
    setError(null);
    try {
      const data = await requestCustomer();
      if (!mounted.current) return;
      setCustomer(data);
    } catch (err) {
      if (!mounted.current) return;
      setError(err?.response?.data?.error?.message || 'Failed to load customer.');
    }
  }, [requestCustomer]);

  /**
   * The net effect of every transaction that is NEWER than the given page.
   *
   * The ledger API pages newest-first, so the rows of an older page do not
   * contain the transactions of the newer pages. Those transactions still
   * change the balance, so their effect has to be added back to find the
   * anchor of the page.
   */
  const accumulateNewerEffect = useCallback(
    async (targetPage) => {
      let effect = 0;
      for (let p = 1; p < targetPage; p += 1) {
        let rows = ledgerCacheRef.current.get(p);
        if (!rows) {
          const data = await fetchCustomerLedger(customerId, { page: p, limit });
          rows = Array.isArray(data.transactions) ? data.transactions : [];
          ledgerCacheRef.current.set(p, rows);
        }
        effect += netBalanceEffect(rows);
      }
      return effect;
    },
    [customerId, limit],
  );

  const fetchLedger = useCallback(
    async (currentPage, isRefresh = false) => {
      const requestSeq = ++requestSeqRef.current;
      if (!isRefresh) setLoading(true);
      else setRefreshing(true);
      setError(null);

      try {
        const [data, customerRow] = await Promise.all([
          fetchCustomerLedger(customerId, { page: currentPage, limit }),
          requestCustomer().catch(() => null),
        ]);
        if (!mounted.current || requestSeq !== requestSeqRef.current) return;

        const rows = Array.isArray(data.transactions) ? data.transactions : [];
        ledgerCacheRef.current.set(currentPage, rows);
        setTransactions(rows);
        setTotal(data.total);
        setPage(data.page);
        setLimit(data.limit);
        setTotalPages(data.totalPages);

        if (!customerRow) {
          // Without the authoritative balance no historical balance can be
          // derived, so the balance column stays empty instead of showing
          // a wrong number.
          setLedgerAnchor(null);
          return;
        }

        const newerEffect = await accumulateNewerEffect(currentPage);
        if (!mounted.current || requestSeq !== requestSeqRef.current) return;
        setLedgerAnchor(computePageAnchor(Number(customerRow?.balance ?? 0), newerEffect));
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
    [customerId, limit, mounted, requestCustomer, accumulateNewerEffect],
  );

  useEffect(() => {
    mounted.current = true;
    // A different customer has a different ledger and a different balance.
    customerRequestRef.current = null;
    ledgerCacheRef.current.clear();
    setLedgerAnchor(null);
    void fetchCustomerData();
    void fetchLedger(page, false);
    return () => { mounted.current = false; };
  }, [fetchCustomerData, fetchLedger, page]);

  const handleRefresh = () => {
    requestSeqRef.current += 1;
    void fetchCustomerData();
    void fetchLedger(page, true);
  };

  /*
   * Running balance.
   *
   * The ledger arrives newest-first (backend order: createdAt DESC, id DESC)
   * and `customer.balance` is the authoritative CURRENT balance, i.e. the
   * balance after every transaction. The historical balances are therefore
   * derived by walking the rows backwards and undoing each transaction's
   * effect, which makes the newest row show exactly `customer.balance`.
   *
   * `ledgerAnchor` is the balance after the newest row of the displayed page;
   * it is null while the balance is unknown, in which case no balance is
   * rendered rather than a wrong one.
   */
  const runningBalance = useMemo(() => {
    if (ledgerAnchor === null) return [];
    return computeRunningBalances(transactions, ledgerAnchor);
  }, [transactions, ledgerAnchor]);

  const balanceById = useMemo(() => {
    const map = new Map();
    for (const row of runningBalance) map.set(row.id, row);
    return map;
  }, [runningBalance]);

  const handleOpenPayment = () => {
    setPaymentForm({ amount: '', description: '' });
    setPaymentErrors({});
    setPaymentError(null);
    setPaymentOpen(true);
  };
  const handleClosePayment = () => {
    // While a payment is unresolved it keeps its key and payload, so the
    // modal is not closed behind the user's back.
    if (paymentLocked) return;
    setPaymentOpen(false);
    setPaymentForm({ amount: '', description: '' });
    setPaymentErrors({});
    setPaymentError(null);
  };

  const validatePayment = () => {
    const errors = {};
    const amountNum = Number(paymentForm.amount);
    const balance = Number(customer?.balance ?? 0);
    if (paymentForm.amount === '' || paymentForm.amount == null) errors.amount = 'Amount is required.';
    else if (!Number.isFinite(amountNum) || amountNum <= 0) errors.amount = 'Amount must be greater than zero.';
    else if (balance <= 0) errors.amount = 'No outstanding balance to pay.';
    else if (amountNum > balance) errors.amount = `Payment exceeds outstanding balance (${formatCurrency(balance)}).`;
    else if (amountNum > 1e9) errors.amount = 'Amount must not exceed 1000000000.';
    return errors;
  };

  const handlePaymentSubmit = async (e) => {
    e.preventDefault();
    const errors = validatePayment();
    if (Object.keys(errors).length > 0) { setPaymentErrors(errors); return; }
    setPaymentErrors({});
    setPaymentError(null);

    // The EXACT body that is sent. It is stored with the key, so a replay
    // sends the very same body and not one rebuilt from the form.
    const payload = buildCustomerPaymentPayload({
      amount: Number(paymentForm.amount),
      description: paymentForm.description,
    });

    setPaying(true);

    try {
      // While a payment is unresolved, a DIFFERENT body is refused instead
      // of sent.
      const outcome = await paymentOperation.submit(payload, customerId);
      applyPaymentOutcome(outcome);
    } finally {
      setPaying(false);
    }
  };

  /**
   * Apply the result of a payment submission to the screen.
   *
   * @param {object} outcome - The result of `paymentOperation.submit()` or
   *   `paymentOperation.retry()`.
   */
  const applyPaymentOutcome = (outcome) => {
    if (outcome.outcome === MONEY_OUTCOME.SENT) {
      // The server confirmed the payment: the UI is built from the values
      // the server returned.
      const transaction = outcome.result?.transaction || {};
      const customer = outcome.result?.customer || {};

      setPaymentOpen(false);
      setPaymentForm({ amount: '', description: '' });
      setSuccessMessage(
        `Payment of ${formatCurrency(transaction.amount)} recorded for ${customer.name || 'the customer'}.`,
      );
      ledgerCacheRef.current.clear();
      requestSeqRef.current += 1;
      void fetchCustomerData();
      void fetchLedger(page, false);
      return;
    }

    // A blocked submission, an ambiguous outcome, a verified failure, a
    // request that could not be sent safely and a request that is already in
    // flight all end up here.
    setPaymentError(outcome.message);
  };

  /** Send the ORIGINAL payment again, unchanged. */
  const handleRetryCustomerPayment = async () => {
    if (paying) return;
    setPaying(true);
    setPaymentError(null);

    try {
      const outcome = await paymentOperation.retry();
      applyPaymentOutcome(outcome);
    } finally {
      setPaying(false);
    }
  };

  /**
   * Explicitly start something else. The original request may already have
   * been committed - this does not undo it.
   */
  const handleAbandonCustomerPayment = () => {
    paymentOperation.abandon();
    setPaymentOpen(false);
    setPaymentForm({ amount: '', description: '' });
    setPaymentErrors({});
    setPaymentError(null);
  };

  const dismissSuccess = () => setSuccessMessage(null);

  const handleOpenDebt = () => {
    setDebtForm({ amount: '', description: '' });
    setDebtErrors({});
    setDebtError(null);
    setDebtOpen(true);
  };
  const handleCloseDebt = () => {
    // While a debt entry is unresolved it keeps its key and payload.
    if (debtLocked) return;
    setDebtOpen(false);
    setDebtForm({ amount: '', description: '' });
    setDebtErrors({});
    setDebtError(null);
  };

  const validateDebt = () => {
    const errors = {};
    const amountNum = Number(debtForm.amount);
    if (debtForm.amount === '' || debtForm.amount == null) errors.amount = 'Amount is required.';
    else if (!Number.isFinite(amountNum) || amountNum <= 0) errors.amount = 'Amount must be greater than zero.';
    else if (amountNum > 1e9) errors.amount = 'Amount must not exceed 1000000000.';
    if (debtForm.description === '' || !debtForm.description.trim()) errors.description = 'Description is required.';
    return errors;
  };

  const handleDebtSubmit = async (e) => {
    e.preventDefault();
    const errors = validateDebt();
    if (Object.keys(errors).length > 0) { setDebtErrors(errors); return; }
    setDebtErrors({});
    setDebtError(null);

    // The EXACT body that is sent. It is stored with the key, so a replay
    // sends the very same body and not one rebuilt from the form.
    const payload = buildCustomerDebtPayload({
      amount: Number(debtForm.amount),
      description: debtForm.description,
    });

    setRecordingDebt(true);

    try {
      // While a debt entry is unresolved, a DIFFERENT body is refused instead
      // of sent.
      const outcome = await debtOperation.submit(payload, customerId);
      applyDebtOutcome(outcome);
    } finally {
      setRecordingDebt(false);
    }
  };

  /**
   * Apply the result of a debt submission to the screen.
   *
   * @param {object} outcome - The result of `debtOperation.submit()` or
   *   `debtOperation.retry()`.
   */
  const applyDebtOutcome = (outcome) => {
    if (outcome.outcome === MONEY_OUTCOME.SENT) {
      // The server confirmed the debt entry: the UI is built from the values
      // the server returned.
      const transaction = outcome.result?.transaction || {};
      const customer = outcome.result?.customer || {};

      setDebtOpen(false);
      setDebtForm({ amount: '', description: '' });
      setSuccessMessage(
        `Debt of ${formatCurrency(transaction.amount)} recorded for ${customer.name || 'the customer'}.`,
      );
      ledgerCacheRef.current.clear();
      requestSeqRef.current += 1;
      void fetchCustomerData();
      void fetchLedger(page, false);
      return;
    }

    // A blocked submission, an ambiguous outcome, a verified failure, a
    // request that could not be sent safely and a request that is already in
    // flight all end up here.
    setDebtError(outcome.message);
  };

  /** Send the ORIGINAL debt entry again, unchanged. */
  const handleRetryCustomerDebt = async () => {
    if (recordingDebt) return;
    setRecordingDebt(true);
    setDebtError(null);

    try {
      const outcome = await debtOperation.retry();
      applyDebtOutcome(outcome);
    } finally {
      setRecordingDebt(false);
    }
  };

  /**
   * Explicitly start something else. The original request may already have
   * been committed - this does not undo it.
   */
  const handleAbandonCustomerDebt = () => {
    debtOperation.abandon();
    setDebtOpen(false);
    setDebtForm({ amount: '', description: '' });
    setDebtErrors({});
    setDebtError(null);
  };

  if (!customer) {
    return (
      <div className="space-y-6 max-w-6xl mx-auto">
        {/* The unresolved warning stays visible while the ledger loads: an
            unresolved operation must never be hidden by a spinner. */}
        <UnresolvedOperationsBanner
          label="payment"
          records={unresolvedPayments.records}
          busy={unresolvedPayments.busy}
          onRetry={unresolvedPayments.retry}
          onAbandon={unresolvedPayments.abandon}
        />
        <UnresolvedOperationsBanner
          label="debt entry"
          records={unresolvedDebts.records}
          busy={unresolvedDebts.busy}
          onRetry={unresolvedDebts.retry}
          onAbandon={unresolvedDebts.abandon}
        />
        <div className="flex flex-col items-center justify-center py-24 text-[var(--app-muted)]">
          <Loader2 className="h-8 w-8 animate-spin mb-3 text-[var(--app-accent)]" />
          <p className="text-sm font-medium">Loading customer ledger…</p>
        </div>
      </div>
    );
  }

  const owesAmount = Math.max(Number(customer.balance ?? 0), 0);
  const hasOutstanding = owesAmount > 0;
  const advanceAmount = Math.max(-Number(customer.balance ?? 0), 0);
  const totalDebits = transactions.filter((t) => t.type !== 'PAYMENT').reduce((s, t) => s + Number(t.amount ?? 0), 0);
  const totalCredits = transactions.filter((t) => t.type === 'PAYMENT').reduce((s, t) => s + Number(t.amount ?? 0), 0);

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* ---------- Header ---------- */}
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={() => navigate('/customers')}
          className="inline-flex w-fit items-center gap-2 text-sm font-medium text-[var(--app-muted)] hover:text-[var(--app-accent)] transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back to People / Udhaar
        </button>

        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-500 text-white text-xl font-extrabold shadow-lg shadow-indigo-500/20">
              {customer.name?.trim().charAt(0).toUpperCase() || '?'}
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-[var(--app-text)]">
                {customer.name}
              </h1>
              <p className="text-sm text-[var(--app-muted)]">
                {customer.phone || customer.email || 'Udhaar ledger'} · {transactions.length} entries
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3.5 py-2.5 text-sm font-medium text-[var(--app-text)] transition hover:bg-[var(--app-panel-2)] disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            {customer.type !== 'RETAIL' && (
              <button
                type="button"
                onClick={handleOpenDebt}
                disabled={recordingDebt}
                className="inline-flex items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3.5 py-2.5 text-sm font-semibold text-[var(--app-text)] transition hover:bg-[var(--app-panel)] disabled:opacity-70"
              >
                <Edit2 className="h-4 w-4" /> Record Debt
              </button>
            )}
            <button
              type="button"
              onClick={handleOpenPayment}
              disabled={paying || !hasOutstanding}
              className="inline-flex items-center gap-2 rounded-xl bg-[var(--app-accent)] px-4 py-2.5 text-sm font-bold text-white shadow-sm shadow-[var(--app-accent)]/20 transition hover:brightness-105 disabled:opacity-60"
            >
              <Plus className="h-4 w-4" /> Record Payment
            </button>
          </div>
        </div>
      </div>

      {/* ---------- Alerts ---------- */}
      {successMessage && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-900/20 dark:text-emerald-300 animate-slide-in" role="status">
          <CheckCircle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{successMessage}</span>
          <button type="button" onClick={dismissSuccess} className="rounded-md p-1 opacity-70 hover:opacity-100 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} className="rounded-md p-1 opacity-70 hover:opacity-100 hover:bg-red-100 dark:hover:bg-red-900/40 transition">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <UnresolvedOperationsBanner
        label="payment"
        records={unresolvedPayments.records}
        busy={unresolvedPayments.busy}
        onRetry={unresolvedPayments.retry}
        onAbandon={unresolvedPayments.abandon}
        onOpen={(record) => {
          if (String(record.entity) !== String(customerId)) return;
          handleOpenPayment();
        }}
      />

      <UnresolvedOperationsBanner
        label="debt entry"
        records={unresolvedDebts.records}
        busy={unresolvedDebts.busy}
        onRetry={unresolvedDebts.retry}
        onAbandon={unresolvedDebts.abandon}
        onOpen={(record) => {
          if (String(record.entity) !== String(customerId)) return;
          handleOpenDebt();
        }}
      />

      {/* ---------- Balance hero + stats ---------- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1 rounded-3xl border border-[var(--app-border)] bg-gradient-to-br from-[var(--app-panel)] to-[var(--app-panel-2)] p-6 relative overflow-hidden">
          <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-[var(--app-accent)]/10 blur-2xl" />
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
            {advanceAmount > 0 ? 'Advance / Paid ahead' : 'Current Udhaar'}
          </p>
          <p className={`mt-2 text-4xl font-extrabold tabular-nums tracking-tight ${
            advanceAmount > 0 ? 'text-emerald-600 dark:text-emerald-400'
            : hasOutstanding ? 'text-amber-600 dark:text-amber-400'
            : 'text-slate-600 dark:text-slate-400'
          }`}>
            {formatCurrency(advanceAmount > 0 ? advanceAmount : owesAmount)}
          </p>
          <p className="mt-2 text-xs text-[var(--app-muted)]">
            {advanceAmount > 0 ? 'You owe this person (advance paid)'
              : hasOutstanding ? 'This person owes you'
              : 'All settled up'}
          </p>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {customer.type && (
              <span className="rounded-full bg-[var(--app-panel-2)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--app-muted)] border border-[var(--app-border)]">
                {customer.type}
              </span>
            )}
            {customer.phone && (
              <span className="rounded-full bg-[var(--app-panel-2)] px-2.5 py-1 text-[11px] font-medium text-[var(--app-muted)] border border-[var(--app-border)]">
                {customer.phone}
              </span>
            )}
          </div>
        </div>

        <StatCard
          icon={TrendingUp}
          label="Total debits (this page)"
          value={formatCurrency(totalDebits)}
          tone="amber"
          hint="Credit sales + manual debt"
        />
        <StatCard
          icon={TrendingDown}
          label="Total credits (this page)"
          value={formatCurrency(totalCredits)}
          tone="emerald"
          hint="Payments received"
        />
      </div>

      {/* ---------- Ledger list ---------- */}
      <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--app-border)]">
          <div className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-[var(--app-muted)]" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--app-text)]">
              Ledger transactions
            </h2>
          </div>
          <span className="text-xs font-medium text-[var(--app-muted)]">
            {total} total
          </span>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-[var(--app-muted)]">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--app-accent)]" />
            <p className="text-sm">Loading ledger…</p>
          </div>
        ) : transactions.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--app-panel-2)]">
              <Banknote className="h-7 w-7 text-[var(--app-muted)]" />
            </div>
            <p className="text-sm font-medium text-[var(--app-text)]">No ledger transactions yet</p>
            <p className="text-xs text-[var(--app-muted)]">Record a payment or debt to get started.</p>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--app-border)]/60">
            {transactions.map((tx) => {
              const cfg = TYPE_CONFIG[tx.type] || TYPE_CONFIG.ADJUSTMENT;
              const Icon = cfg.icon;
              const amount = Number(tx.amount ?? 0);
              const isPayment = tx.type === 'PAYMENT';
              const row = balanceById.get(tx.id);
              return (
                <li key={tx.id} className="group px-5 py-4 hover:bg-[var(--app-panel-2)]/40 transition-colors">
                  <div className="flex items-center gap-4">
                    <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${cfg.ring}`}>
                      <Icon className="h-5 w-5" />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-[var(--app-text)] truncate">
                          {cfg.label}
                        </p>
                        {tx.saleId && (
                          <span className="rounded-md bg-[var(--app-panel-2)] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--app-muted)] border border-[var(--app-border)]">
                            Sale #{tx.saleId}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--app-muted)]">
                        <Calendar className="h-3 w-3" />
                        <span>{formatDate(tx.createdAt)}</span>
                        {tx.description && (
                          <>
                            <span className="opacity-40">·</span>
                            <span className="truncate">{tx.description}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <p className={`text-sm font-bold tabular-nums inline-flex items-center gap-1 ${
                        isPayment ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
                      }`}>
                        {isPayment ? <ArrowDownRight className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
                        {isPayment ? '-' : '+'}{formatCurrency(amount)}
                      </p>
                      {row && (
                        <p className="mt-0.5 text-[11px] text-[var(--app-muted)] tabular-nums">
                          Bal: {formatCurrency(row.after)}
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ---------- Pagination ---------- */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3">
          <p className="text-sm text-[var(--app-muted)]">
            Page <span className="font-semibold text-[var(--app-text)]">{page}</span> of {totalPages}
            <span className="hidden sm:inline"> · {total} transactions</span>
          </p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1 || loading}
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3 py-2 text-sm font-medium text-[var(--app-text)] transition hover:bg-[var(--app-panel)] disabled:opacity-40 disabled:pointer-events-none"
            >
              <ChevronLeft className="h-4 w-4" /> Prev
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages || loading}
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3 py-2 text-sm font-medium text-[var(--app-text)] transition hover:bg-[var(--app-panel)] disabled:opacity-40 disabled:pointer-events-none"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* ---------- Payment modal ---------- */}
      <ModalShell
        open={paymentOpen}
        onClose={handleClosePayment}
        icon={CreditCard}
        title="Record payment received"
        description={`From ${customer.name}. Cannot exceed outstanding balance of ${formatCurrency(Number(customer.balance ?? 0))}.`}
        tone="emerald"
      >
        <form onSubmit={handlePaymentSubmit} className="space-y-4">
          <UnresolvedOperationNotice
            label="payment"
            unresolved={paymentOperation.unresolved}
            busy={paying}
            onRetry={handleRetryCustomerPayment}
            onAbandon={handleAbandonCustomerPayment}
          />

          <fieldset disabled={paymentLocked} className="space-y-4">
          <Field label="Amount (Rs.)" error={paymentErrors.amount}>
            <input
              type="number" min="0" max={Number(customer.balance ?? 0)} step="0.01"
              value={paymentForm.amount}
              onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })}
              className={inputClass}
              placeholder="0.00"
              autoFocus
            />
          </Field>
          <Field label="Description">
            <input
              type="text"
              value={paymentForm.description}
              onChange={(e) => setPaymentForm({ ...paymentForm, description: e.target.value })}
              className={inputClass}
              placeholder="e.g., Paid cash, Bank transfer…"
            />
          </Field>
          {paymentError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
              {paymentError}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={handleClosePayment} disabled={paying}
              className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-4 py-2.5 text-sm font-semibold text-[var(--app-text)] transition hover:bg-[var(--app-panel)] disabled:opacity-60">
              Cancel
            </button>
            <button type="submit" disabled={paying}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-70">
              {paying ? <><Loader2 className="h-4 w-4 animate-spin" /> Recording…</> : <><Plus className="h-4 w-4" /> Record payment</>}
            </button>
          </div>
                </fieldset>
</form>
      </ModalShell>

      {/* ---------- Debt modal ---------- */}
      <ModalShell
        open={debtOpen}
        onClose={handleCloseDebt}
        icon={Banknote}
        title="Record manual debt"
        description={`Amount owed by ${customer.name}. Does not create a sale or change inventory.`}
        tone="purple"
      >
        <form onSubmit={handleDebtSubmit} className="space-y-4">
          <UnresolvedOperationNotice
            label="debt entry"
            unresolved={debtOperation.unresolved}
            busy={recordingDebt}
            onRetry={handleRetryCustomerDebt}
            onAbandon={handleAbandonCustomerDebt}
          />

          <fieldset disabled={debtLocked} className="space-y-4">
          <Field label="Amount owed (Rs.)" error={debtErrors.amount}>
            <input
              type="number" min="0" step="0.01"
              value={debtForm.amount}
              onChange={(e) => setDebtForm({ ...debtForm, amount: e.target.value })}
              className={inputClass}
              placeholder="0.00"
              autoFocus
            />
          </Field>
          <Field label="Description / reason" error={debtErrors.description}>
            <input
              type="text"
              value={debtForm.description}
              onChange={(e) => setDebtForm({ ...debtForm, description: e.target.value })}
              className={inputClass}
              placeholder="e.g., Supply of goods, Service charge…"
            />
          </Field>
          {debtError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
              {debtError}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={handleCloseDebt} disabled={recordingDebt}
              className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-4 py-2.5 text-sm font-semibold text-[var(--app-text)] transition hover:bg-[var(--app-panel)] disabled:opacity-60">
              Cancel
            </button>
            <button type="submit" disabled={recordingDebt}
              className="inline-flex items-center gap-2 rounded-xl bg-purple-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-purple-700 disabled:opacity-70">
              {recordingDebt ? <><Loader2 className="h-4 w-4 animate-spin" /> Recording…</> : <><Plus className="h-4 w-4" /> Record debt</>}
            </button>
          </div>
                </fieldset>
</form>
      </ModalShell>
    </div>
  );
}