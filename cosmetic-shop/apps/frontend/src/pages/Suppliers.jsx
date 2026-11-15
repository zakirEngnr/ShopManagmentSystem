import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  DollarSign,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Truck,
  Wallet,
  X,
  Building2,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  UserPlus,
} from 'lucide-react';
import {
  createSupplier,
  fetchSuppliers,
  recordSupplierPayment,
  buildSupplierPaymentPayload,
} from '../api/suppliers';
import { useMoneyOperation } from '../hooks/useMoneyOperation.js';
import { useUnresolvedOperations } from '../hooks/useUnresolvedOperations.js';
import { MONEY_OUTCOME } from '../utils/moneyOperation.js';
import UnresolvedOperationNotice from '../components/UnresolvedOperationNotice.jsx';
import UnresolvedOperationsBanner from '../components/UnresolvedOperationsBanner.jsx';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Send a supplier payment. The body is put on the wire unchanged; the
 * supplier id comes from the entity that is stored with the operation.
 */
const sendSupplierPayment = (body, key, entity) =>
  recordSupplierPayment(Number(entity), body, key);

const formatCurrency = (value) => {
  if (value === null || value === undefined || value === '') return 'Rs. 0';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'Rs. 0';
  return `Rs. ${numeric.toLocaleString('en-PK', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
};

const formatText = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
};

const getEmptyForm = () => ({
  name: '',
  phone: '',
  email: '',
  address: '',
  notes: '',
});

const initialsOf = (name) => {
  const clean = String(name ?? '').trim();
  if (!clean) return '?';
  const parts = clean.split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join('');
};

/* ------------------------------------------------------------------ */
/* small primitives                                                    */
/* ------------------------------------------------------------------ */

function StatCard({ icon: Icon, label, value, tone = 'default', hint }) {
  const toneMap = {
    default: 'bg-[var(--app-panel)] border-[var(--app-border)]',
    amber:   'bg-amber-50/60 dark:bg-amber-900/10 border-amber-100 dark:border-amber-900/40',
    emerald: 'bg-emerald-50/60 dark:bg-emerald-900/10 border-emerald-100 dark:border-emerald-900/40',
  };
  return (
    <div className={`rounded-2xl border p-5 ${toneMap[tone]}`}>
      <div className="flex items-center justify-between text-[var(--app-muted)]">
        <span className="text-xs font-semibold uppercase tracking-wider">{label}</span>
        <Icon className="h-4 w-4" />
      </div>
      <p className="mt-3 text-2xl font-extrabold tabular-nums text-[var(--app-text)]">{value}</p>
      {hint && <p className="mt-1 text-xs text-[var(--app-muted)]">{hint}</p>}
    </div>
  );
}

function ModalShell({ open, onClose, icon: Icon, title, subtitle, tone = 'indigo', children }) {
  if (!open) return null;
  const toneMap = {
    indigo: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300',
    amber:  'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300',
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-md" onClick={onClose} />
      <div className="relative w-full max-w-xl rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in">
        <div className="mb-5 flex items-start gap-3">
          <span className={`inline-flex h-10 w-10 items-center justify-center rounded-2xl ${toneMap[tone]}`}>
            <Icon className="h-5 w-5" />
          </span>
          <div className="flex-1">
            <h2 className="text-lg font-extrabold text-[var(--app-text)]">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-[var(--app-muted)]">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--app-muted)] transition-colors hover:bg-[var(--app-panel-2)]"
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
      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
        {label}
      </label>
      {children}
      {error && <p className="mt-1.5 text-xs font-medium text-red-600">{error}</p>}
    </div>
  );
}

const inputClass =
  'w-full px-3.5 py-2.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

export default function Suppliers() {
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [limit] = useState(10);
  const [outstandingTotal, setOutstandingTotal] = useState(0);
  const [successMessage, setSuccessMessage] = useState(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(getEmptyForm());
  const [formErrors, setFormErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const [paymentTarget, setPaymentTarget] = useState(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentForm, setPaymentForm] = useState({ amount: '', description: '' });
  const [paymentErrors, setPaymentErrors] = useState({});
  const [paying, setPaying] = useState(false);
  const [paymentError, setPaymentError] = useState(null);

  // The idempotency key AND the payload of the payment that is being
  // recorded. A retry reuses both, so the payable is not reduced twice.
  // The scope contains the supplier id, so a payment for one supplier can
  // never block or reuse the key of a payment for another one.
  const paymentScope = `supplier-payment:${paymentTarget?.id ?? 'none'}`;
  const paymentOperation = useMoneyOperation({
    scope: paymentScope,
    operation: 'POST /suppliers/:id/payment',
    label: 'payment',
    send: sendSupplierPayment,
  });
  const paymentLocked = paymentOperation.locked;

  // The same warning at the page level: an unresolved payment must stay
  // visible even when the payment dialog is closed.
  const unresolvedPayments = useUnresolvedOperations({
    workflow: 'supplier-payment',
    operation: 'POST /suppliers/:id/payment',
    label: 'payment',
    send: sendSupplierPayment,
  });

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / limit)), [total, limit]);

  const loadSuppliers = async (manual = false) => {
    if (manual) setRefreshing(true);
    else setLoading(true);
    setLoadError(null);

    try {
      const response = await fetchSuppliers({ page, limit, search });
      setSuppliers(response.suppliers);
      setTotal(response.total);
      setPage(response.page);
      setOutstandingTotal(response.outstandingTotal ?? 0);
    } catch (error) {
      setLoadError(
        error?.response?.data?.error?.message || error?.message || 'Failed to load suppliers.'
      );
      setSuppliers([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadSuppliers(false);
  }, [page, search]);

  const summary = useMemo(() => {
    return {
      count: total || suppliers.length,
      outstanding: outstandingTotal,
    };
  }, [total, outstandingTotal]);

  const validateForm = () => {
    const errors = {};
    if (!String(form.name ?? '').trim()) {
      errors.name = 'Supplier name is required.';
    }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(form.email).trim())) {
      errors.email = 'Enter a valid email address.';
    }
    return errors;
  };

  const openModal = () => {
    setModalOpen(true);
    setForm(getEmptyForm());
    setFormErrors({});
    setSubmitError(null);
  };

  const closeModal = () => {
    setModalOpen(false);
    setForm(getEmptyForm());
    setFormErrors({});
    setSubmitError(null);
  };

  const handleCreateSupplier = async (event) => {
    event.preventDefault();
    const errors = validateForm();
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }

    setSaving(true);
    setSubmitError(null);

    try {
      await createSupplier(form);
      setSuccessMessage('Supplier added successfully.');
      closeModal();
      setPage(1);
      await loadSuppliers(true);
    } catch (error) {
      setSubmitError(
        error?.response?.data?.error?.message || error?.message || 'Failed to add supplier.'
      );
    } finally {
      setSaving(false);
    }
  };

  const handlePaymentSubmit = async (event) => {
    event.preventDefault();
    if (!paymentTarget) return;

    const amount = Number(paymentForm.amount);
    const errors = {};

    if (!Number.isFinite(amount) || amount <= 0) {
      errors.amount = 'Payment amount must be greater than zero.';
    }
    if (amount > Number(paymentTarget.balance ?? 0)) {
      errors.amount = 'Payment cannot exceed the outstanding payable balance.';
    }

    if (Object.keys(errors).length > 0) {
      setPaymentErrors(errors);
      return;
    }

    // The EXACT body that is sent. It is stored with the key, so a replay
    // sends the very same body and not one rebuilt from the form.
    const payload = buildSupplierPaymentPayload({
      amount: Number(amount),
      description: paymentForm.description,
    });

    setPaying(true);
    setPaymentError(null);

    try {
      // While a payment is unresolved, a DIFFERENT body is refused instead
      // of sent.
      const outcome = await paymentOperation.submit(payload, paymentTarget.id);
      applyOutcome(outcome);
    } finally {
      setPaying(false);
    }
  };

  /**
   * Apply the result of a submission to the screen.
   *
   * @param {object} outcome - The result of `paymentOperation.submit()` or
   *   `paymentOperation.retry()`.
   */
  const applyOutcome = (outcome) => {
    if (outcome.outcome === MONEY_OUTCOME.SENT) {
      // The server confirmed the payment: the UI is built from the values
      // the server returned.
      const payment = outcome.result?.payment || {};
      const supplier = outcome.result?.supplier || {};
      const allocations = Array.isArray(outcome.result?.allocations) ? outcome.result.allocations.length : 0;

      setSuccessMessage(
        `Supplier payment of ${formatCurrency(payment.amount)} recorded for ${supplier.name || 'the supplier'}` +
          (allocations ? ` (${allocations} purchase${allocations === 1 ? '' : 's'} settled)` : '') +
          `.`,
      );
      setPaymentOpen(false);
      setPaymentTarget(null);
      setPaymentForm({ amount: '', description: '' });
      setPaymentErrors({});
      setPaymentError(null);
      setPage(1);
      void loadSuppliers(true);
      return;
    }

    // A blocked submission, an ambiguous outcome, a verified failure, a
    // request that could not be sent safely and a request that is already in
    // flight all end up here.
    setPaymentError(outcome.message);
  };

  /** Send the ORIGINAL payment again, unchanged. */
  const handleRetrySupplierPayment = async () => {
    if (paying) return;
    setPaying(true);
    setPaymentError(null);

    try {
      const outcome = await paymentOperation.retry();
      applyOutcome(outcome);
    } finally {
      setPaying(false);
    }
  };

  /**
   * Explicitly start something else. The original request may already have
   * been committed - this does not undo it.
   */
  const handleAbandonSupplierPayment = () => {
    paymentOperation.abandon();
    setPaymentOpen(false);
    setPaymentTarget(null);
    setPaymentForm({ amount: '', description: '' });
    setPaymentErrors({});
    setPaymentError(null);
  };

  const closePaymentModal = () => {
    // While a payment is unresolved it keeps its key and payload, so the
    // modal is not closed behind the user's back.
    if (paymentLocked) return;
    setPaymentOpen(false);
    setPaymentTarget(null);
    setPaymentForm({ amount: '', description: '' });
    setPaymentErrors({});
    setPaymentError(null);
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* ---------- header ---------- */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--app-muted)]">
            Suppliers
          </p>
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-[var(--app-text)]">
            Supplier Payables
          </h1>
          <p className="mt-1 text-sm text-[var(--app-muted)]">
            Track supplier balances, record payments, and keep payables tidy.
          </p>
        </div>
        <button
          type="button"
          onClick={openModal}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm shadow-indigo-600/20 transition hover:bg-indigo-500"
        >
          <Plus className="h-4 w-4" />
          Add supplier
        </button>
      </div>

      {/* ---------- summary stats ---------- */}
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard icon={Truck} label="Suppliers" value={summary.count} hint="Total in your list" />
        <StatCard
          icon={Wallet}
          label="Outstanding payable"
          value={formatCurrency(summary.outstanding)}
          tone={summary.outstanding > 0 ? 'amber' : 'emerald'}
          hint="Across all suppliers"
        />
        <StatCard
          icon={DollarSign}
          label="Status"
          value={summary.outstanding > 0 ? 'Payables due' : 'All clear'}
          tone={summary.outstanding > 0 ? 'amber' : 'emerald'}
          hint={summary.outstanding > 0 ? 'Settle to keep books clean' : 'No outstanding balance'}
        />
      </div>

      {/* ---------- search ---------- */}
      <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-3">
        <label className="relative block">
          <span className="sr-only">Search suppliers</span>
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--app-muted)]" />
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search supplier name…"
            className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] py-2.5 pl-10 pr-4 text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
          />
        </label>
      </div>

      {/* ---------- alerts ---------- */}
      {successMessage && (
        <div
          className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-900/20 dark:text-emerald-300 animate-slide-in"
          role="status"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span className="flex-1">{successMessage}</span>
          <button
            type="button"
            onClick={() => setSuccessMessage(null)}
            className="rounded-md p-1 opacity-70 transition hover:bg-emerald-100 hover:opacity-100 dark:hover:bg-emerald-900/40"
            aria-label="Dismiss"
          >
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
          const supplier = suppliers.find((entry) => entry.id === Number(record.entity));
          if (!supplier) return;
          setPaymentTarget(supplier);
          setPaymentForm({ amount: '', description: '' });
          setPaymentErrors({});
          setPaymentError(null);
          setPaymentOpen(true);
        }}
      />

      {loadError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{loadError}</span>
        </div>
      )}

      {/* ---------- list ---------- */}
      {loading ? (
        <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)]">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--app-muted)]">
            <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
            Loading suppliers…
          </div>
        </div>
      ) : suppliers.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] p-12 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--app-panel-2)]">
            <Building2 className="h-7 w-7 text-[var(--app-muted)]" />
          </div>
          <p className="text-sm font-semibold text-[var(--app-text)]">No suppliers found</p>
          <p className="max-w-sm text-xs text-[var(--app-muted)]">
            {search
              ? 'No suppliers match your search. Try a different name.'
              : 'Add your first supplier to start tracking payables.'}
          </p>
          {!search && (
            <button
              type="button"
              onClick={openModal}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-indigo-500"
            >
              <UserPlus className="h-3.5 w-3.5" /> Add supplier
            </button>
          )}
        </div>
      ) : (
        <ul className="space-y-3">
          {suppliers.map((supplier) => {
            const balance = Number(supplier?.balance ?? 0);
            const isDue = balance > 0;
            const hasContact = supplier.phone || supplier.email || supplier.address;

            return (
              <li
                key={supplier.id}
                className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 transition hover:border-indigo-200 hover:shadow-sm dark:hover:border-indigo-900/60"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  {/* left: identity + contact */}
                  <div className="flex min-w-0 flex-1 gap-4">
                    <div
                      className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-sm font-extrabold text-white shadow-sm ${
                        isDue
                          ? 'bg-gradient-to-br from-amber-500 to-orange-500 shadow-amber-500/20'
                          : 'bg-gradient-to-br from-emerald-500 to-teal-500 shadow-emerald-500/20'
                      }`}
                    >
                      {initialsOf(supplier.name)}
                    </div>

                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-base font-bold text-[var(--app-text)]">
                          {formatText(supplier.name)}
                        </h2>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${
                            isDue
                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                              : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                          }`}
                        >
                          {isDue ? 'Payable' : 'Settled'}
                        </span>
                      </div>

                      {hasContact ? (
                        <div className="grid gap-1.5 text-sm text-[var(--app-text-soft)] md:grid-cols-2">
                          {supplier.phone && (
                            <div className="flex items-center gap-2">
                              <Phone className="h-3.5 w-3.5 shrink-0 text-[var(--app-muted)]" />
                              <span className="truncate">{formatText(supplier.phone)}</span>
                            </div>
                          )}
                          {supplier.email && (
                            <div className="flex items-center gap-2">
                              <Mail className="h-3.5 w-3.5 shrink-0 text-[var(--app-muted)]" />
                              <span className="truncate">{formatText(supplier.email)}</span>
                            </div>
                          )}
                          {supplier.address && (
                            <div className="flex items-center gap-2 md:col-span-2">
                              <MapPin className="h-3.5 w-3.5 shrink-0 text-[var(--app-muted)]" />
                              <span className="truncate">{formatText(supplier.address)}</span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-xs italic text-[var(--app-muted)]">No contact details</p>
                      )}

                      {supplier.notes && (
                        <p className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-2)] px-2.5 py-1.5 text-xs text-[var(--app-text-soft)]">
                          {supplier.notes}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* right: payable + action */}
                  <div className="w-full shrink-0 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] p-4 lg:w-60">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--app-muted)]">
                      Outstanding payable
                    </p>
                    <p
                      className={`mt-1 text-2xl font-extrabold tabular-nums ${
                        isDue
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-emerald-600 dark:text-emerald-400'
                      }`}
                    >
                      {formatCurrency(balance)}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setPaymentTarget(supplier);
                        setPaymentOpen(true);
                        setPaymentError(null);
                      }}
                      disabled={!isDue}
                      className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-900/60 dark:bg-indigo-900/20 dark:text-indigo-300 dark:hover:bg-indigo-900/30"
                    >
                      <CreditCard className="h-4 w-4" />
                      Record payment
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* ---------- pagination ---------- */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3">
          <p className="text-sm text-[var(--app-muted)]">
            Page <span className="font-semibold text-[var(--app-text)]">{page}</span> of {totalPages}
          </p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1}
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3 py-2 text-sm font-medium text-[var(--app-text)] transition hover:bg-[var(--app-panel)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" /> Prev
            </button>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={page >= totalPages}
              className="inline-flex items-center gap-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3 py-2 text-sm font-medium text-[var(--app-text)] transition hover:bg-[var(--app-panel)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* ---------- add supplier modal ---------- */}
      <ModalShell
        open={modalOpen}
        onClose={closeModal}
        icon={UserPlus}
        title="Add supplier"
        subtitle="Capture contact details so payables and payments stay in one place."
        tone="indigo"
      >
        <form onSubmit={handleCreateSupplier} className="space-y-4">
          <Field label="Supplier name" error={formErrors.name}>
            <input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              className={inputClass}
              placeholder="e.g. Beauty Supplies Co."
              autoFocus
            />
          </Field>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Phone">
              <input
                value={form.phone}
                onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))}
                className={inputClass}
                placeholder="+92 300 1234567"
              />
            </Field>
            <Field label="Email" error={formErrors.email}>
              <input
                value={form.email}
                onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                className={inputClass}
                placeholder="supplier@example.com"
              />
            </Field>
          </div>

          <Field label="Address">
            <textarea
              value={form.address}
              onChange={(event) => setForm((current) => ({ ...current, address: event.target.value }))}
              rows="2"
              className={inputClass}
              placeholder="Street, city, region"
            />
          </Field>

          <Field label="Notes">
            <textarea
              value={form.notes}
              onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
              rows="2"
              className={inputClass}
              placeholder="Preferred terms or contact details"
            />
          </Field>

          {submitError && (
            <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {submitError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={closeModal}
              className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-4 py-2.5 text-sm font-semibold text-[var(--app-text)] transition hover:bg-[var(--app-panel)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" /> Save supplier
                </>
              )}
            </button>
          </div>
        </form>
      </ModalShell>

      {/* ---------- record payment modal ---------- */}
      <ModalShell
        open={paymentOpen && Boolean(paymentTarget)}
        onClose={closePaymentModal}
        icon={CreditCard}
        title="Record payment"
        subtitle={
          paymentTarget
            ? `Paying ${formatText(paymentTarget.name)} — outstanding ${formatCurrency(
                Number(paymentTarget.balance ?? 0)
              )}`
            : undefined
        }
        tone="amber"
      >
        {paymentTarget && (
          <form onSubmit={handlePaymentSubmit} className="space-y-4">
            <UnresolvedOperationNotice
              label="payment"
              unresolved={paymentOperation.unresolved}
              busy={paying}
              onRetry={handleRetrySupplierPayment}
              onAbandon={handleAbandonSupplierPayment}
            />

            <fieldset disabled={paymentLocked} className="space-y-4">
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">Outstanding payable</span>
                <strong className="tabular-nums">
                  {formatCurrency(Number(paymentTarget.balance ?? 0))}
                </strong>
              </div>
            </div>

            <Field label="Amount (Rs.)" error={paymentErrors.amount}>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={paymentForm.amount}
                onChange={(event) =>
                  setPaymentForm((current) => ({ ...current, amount: event.target.value }))
                }
                className={inputClass}
                placeholder="0.00"
                autoFocus
              />
            </Field>

            <Field label="Description">
              <textarea
                value={paymentForm.description}
                onChange={(event) =>
                  setPaymentForm((current) => ({ ...current, description: event.target.value }))
                }
                rows="2"
                className={inputClass}
                placeholder="Optional payment reference"
              />
            </Field>

            {paymentError && (
              <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {paymentError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={closePaymentModal}
                className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-4 py-2.5 text-sm font-semibold text-[var(--app-text)] transition hover:bg-[var(--app-panel)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={paying}
                className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {paying ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Recording…
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4" /> Confirm payment
                  </>
                )}
              </button>
            </div>
                      </fieldset>
</form>
        )}
      </ModalShell>

      {/* ---------- refreshing toast ---------- */}
      {refreshing && (
        <div className="fixed bottom-6 right-6 flex items-center gap-2 rounded-full border border-[var(--app-border)] bg-[var(--app-panel)] px-3.5 py-2 text-sm font-medium text-[var(--app-text-soft)] shadow-lg animate-slide-in">
          <RefreshCw className="h-4 w-4 animate-spin text-indigo-500" />
          Refreshing…
        </div>
      )}
    </div>
  );
}