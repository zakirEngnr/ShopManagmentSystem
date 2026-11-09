import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock,
  DollarSign,
  Loader2,
  Plus,
  ReceiptText,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { createExpense, deleteExpense, fetchExpenses } from '../api/expenses';

const EXPENSE_CATEGORIES = ['RENT', 'SALARIES', 'UTILITIES', 'PACKAGING', 'TRANSPORT', 'MARKETING', 'OTHER'];

const CATEGORY_STYLES = {
  RENT: 'bg-rose-100 text-rose-700 border border-rose-200',
  SALARIES: 'bg-indigo-100 text-indigo-700 border border-indigo-200',
  UTILITIES: 'bg-amber-100 text-amber-700 border border-amber-200',
  PACKAGING: 'bg-violet-100 text-violet-700 border border-violet-200',
  TRANSPORT: 'bg-sky-100 text-sky-700 border border-sky-200',
  MARKETING: 'bg-fuchsia-100 text-fuchsia-700 border border-fuchsia-200',
  OTHER: 'bg-slate-100 text-slate-700 border border-slate-200',
};

const getDateInputValue = (date = new Date()) => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseDateValue = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

const formatCurrency = (value) => {
  if (value === null || value === undefined || value === '') return 'N/A';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  return `Rs. ${numeric.toLocaleString('en-PK', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
};

const formatExpenseDate = (value) => {
  const date = parseDateValue(value);
  if (!date) return 'Date unavailable';

  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
};

const getUtcDateKey = (date) => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getUtcMonthKey = (date) => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

const getEmptyForm = () => ({
  date: getDateInputValue(new Date()),
  category: 'RENT',
  description: '',
  amount: '',
});

export default function Expenses() {
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState(getEmptyForm());
  const [formErrors, setFormErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [expenseToDelete, setExpenseToDelete] = useState(null);
  const [deletingExpenseId, setDeletingExpenseId] = useState(null);
  const [deleteError, setDeleteError] = useState(null);

  const requestIdRef = useRef(0);
  const busyRef = useRef(false);

  const loadExpenses = useCallback(async (manualRefresh = false) => {
    if (busyRef.current) return;

    const requestId = ++requestIdRef.current;
    const isCurrent = () => requestId === requestIdRef.current;

    busyRef.current = true;
    if (manualRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setSuccessMessage(null);
    }
    setLoadError(null);

    try {
      let page = 1;
      let totalPages = 1;
      const allExpenses = [];

      while (page <= totalPages) {
        const response = await fetchExpenses(page, 100);
        if (!isCurrent()) return;

        if (Array.isArray(response.items)) {
          allExpenses.push(...response.items);
        }

        if (!Number.isInteger(response.totalPages) || response.totalPages < 1) {
          totalPages = Math.max(1, Math.ceil(response.total / Math.max(response.limit, 1)));
        } else {
          totalPages = response.totalPages;
        }

        page += 1;
      }

      if (!isCurrent()) return;
      setExpenses(allExpenses);
    } catch (error) {
      if (!isCurrent()) return;
      setLoadError(error?.response?.data?.message || error?.message || 'Failed to load expenses.');
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setRefreshing(false);
        busyRef.current = false;
      }
    }
  }, []);

  useEffect(() => {
    loadExpenses(false);
    return () => {
      requestIdRef.current += 1;
      busyRef.current = false;
    };
  }, [loadExpenses]);

  const totalSummary = useMemo(() => {
    const now = new Date();
    const todayKey = getUtcDateKey(now);
    const thisMonthKey = getUtcMonthKey(now);

    let todayTotal = 0;
    let monthTotal = 0;

    for (const expense of expenses) {
      const amount = Number(expense.amount);
      if (!Number.isFinite(amount)) continue;

      const parsedDate = parseDateValue(expense.date);
      if (!parsedDate) continue;

      const itemMonthKey = getUtcMonthKey(parsedDate);
      const itemDayKey = getUtcDateKey(parsedDate);

      if (itemMonthKey === thisMonthKey) {
        monthTotal += amount;
      }
      if (itemDayKey === todayKey) {
        todayTotal += amount;
      }
    }

    return {
      today: todayTotal,
      month: monthTotal,
    };
  }, [expenses]);

  const validateForm = (values) => {
    const nextErrors = {};

    if (!values.date) {
      nextErrors.date = 'Date is required.';
    } else if (Number.isNaN(Date.parse(values.date))) {
      nextErrors.date = 'Please provide a valid date.';
    }

    if (!values.category) {
      nextErrors.category = 'Category is required.';
    } else if (!EXPENSE_CATEGORIES.includes(values.category)) {
      nextErrors.category = 'Choose a valid category.';
    }

    if (!values.description || !String(values.description).trim()) {
      nextErrors.description = 'Description is required.';
    } else if (String(values.description).trim().length > 255) {
      nextErrors.description = 'Description must be 255 characters or less.';
    }

    const amountValue = Number(values.amount);
    if (values.amount === '' || values.amount === null || values.amount === undefined) {
      nextErrors.amount = 'Amount is required.';
    } else if (!Number.isFinite(amountValue) || amountValue <= 0) {
      nextErrors.amount = 'Amount must be greater than zero.';
    } else if (amountValue > 1_000_000_000) {
      nextErrors.amount = 'Amount is too large.';
    }

    return nextErrors;
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setForm(getEmptyForm());
    setFormErrors({});
    setSubmitError(null);
  };

  const handleSubmitExpense = async (event) => {
    event.preventDefault();

    const nextErrors = validateForm(form);
    setFormErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const payload = {
      date: form.date,
      category: form.category,
      description: String(form.description).trim(),
      amount: Number(form.amount),
    };

    setSaving(true);
    setSubmitError(null);

    try {
      await createExpense(payload);
      setSuccessMessage('Expense added successfully.');
      closeModal();
      await loadExpenses(true);
    } catch (error) {
      const apiMessage = error?.response?.data?.message || error?.message || 'Unable to create the expense.';
      setSubmitError(apiMessage);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteExpense = async () => {
    if (!expenseToDelete) return;

    setDeletingExpenseId(expenseToDelete.id);
    setDeleteError(null);

    try {
      await deleteExpense(expenseToDelete.id);
      setSuccessMessage('Expense deleted successfully.');
      setExpenseToDelete(null);
      await loadExpenses(true);
    } catch (error) {
      const apiMessage = error?.response?.data?.message || error?.message || 'Unable to delete this expense.';
      setDeleteError(apiMessage);
    } finally {
      setDeletingExpenseId(null);
    }
  };

  const renderSummaryCard = ({ label, value, color, bg, Icon }) => (
    <div
      key={label}
      className="group relative overflow-hidden rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-xl"
    >
      <div className={`absolute inset-y-0 right-0 w-24 rounded-l-full bg-gradient-to-br ${bg} opacity-80`} />
      <div className="relative z-10 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">{label}</p>
          <div className={`mt-4 text-2xl font-extrabold tracking-tight ${color}`}>
            {formatCurrency(value)}
          </div>
        </div>
        <div className={`rounded-2xl border border-[var(--app-border)] p-3 ${bg} ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-[0_16px_40px_rgba(15,23,42,0.08)] sm:p-7">
        <div className="flex items-center justify-center gap-3 py-20 text-[var(--app-text-soft)]">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="font-medium">Loading expenses...</span>
        </div>
      </div>
    );
  }

  if (loadError && !expenses.length) {
    return (
      <div className="max-w-7xl mx-auto rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-[0_16px_40px_rgba(15,23,42,0.08)] sm:p-7">
        <div className="rounded-3xl border border-red-200 bg-red-50 p-6 text-red-700">
          <p className="text-lg font-bold">Unable to load expenses</p>
          <p className="mt-2 text-sm">{loadError}</p>
          <button
            type="button"
            onClick={() => loadExpenses(true)}
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-red-700"
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-fade-in max-w-7xl mx-auto rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-[0_16px_40px_rgba(15,23,42,0.08)] sm:p-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-3 flex items-center gap-2">
            <div className="rounded-xl bg-amber-100 p-2 text-amber-700">
              <ReceiptText className="h-5 w-5" />
            </div>
            <span className="text-xs font-bold uppercase tracking-[0.15em] text-amber-600">Operations</span>
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--app-text)]">Expenses</h1>
          <p className="mt-1 text-sm font-medium text-[var(--app-muted)]">Track your shop's operating costs.</p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => loadExpenses(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-4 py-2.5 text-sm font-bold text-[var(--app-text)] shadow-sm transition hover:bg-[var(--app-panel)] disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>

          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--app-accent)] px-4 py-2.5 text-sm font-bold text-white shadow-sm shadow-indigo-200 transition hover:brightness-105"
          >
            <Plus className="h-4 w-4" />
            Add Expense
          </button>
        </div>
      </div>

      {successMessage && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
          {successMessage}
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        {renderSummaryCard({
          label: 'Total Expenses — This Month',
          value: totalSummary.month,
          color: 'text-amber-700',
          bg: 'bg-amber-100',
          Icon: CalendarClock,
        })}

        {renderSummaryCard({
          label: 'Total Expenses — Today',
          value: totalSummary.today,
          color: 'text-red-700',
          bg: 'bg-red-100',
          Icon: DollarSign,
        })}
      </div>

      {loadError && expenses.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-700">
          {loadError}
        </div>
      )}

      {expenses.length === 0 ? (
        <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel-2)] p-10 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-700">
            <Sparkles className="h-5 w-5" />
          </div>
          <h2 className="text-lg font-bold text-[var(--app-text)]">No expenses recorded yet.</h2>
        </div>
      ) : (
        <div className="overflow-hidden rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-[var(--app-border)]">
              <thead className="bg-[var(--app-panel-2)]">
                <tr>
                  {['Date', 'Category', 'Description', 'Amount', 'Actions'].map((column) => (
                    <th
                      key={column}
                      className="px-5 py-3 text-left text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--app-border)]">
                {expenses.map((expense) => (
                  <tr key={expense.id} className="transition-colors hover:bg-[var(--app-panel-2)]">
                    <td className="px-5 py-4 text-sm font-medium text-[var(--app-text)]">
                      {formatExpenseDate(expense.date)}
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${CATEGORY_STYLES[expense.category] || 'bg-slate-100 text-slate-700 border border-slate-200'}`}
                      >
                        {expense.category}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-sm text-[var(--app-text-soft)]">
                      {expense.description}
                    </td>
                    <td className="px-5 py-4 text-sm font-bold text-red-600">
                      {formatCurrency(expense.amount)}
                    </td>
                    <td className="px-5 py-4">
                      <button
                        type="button"
                        onClick={() => setExpenseToDelete(expense)}
                        className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 transition hover:bg-red-100"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => !saving && closeModal()} />
          <div className="relative w-full max-w-lg rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">New expense</p>
                <h2 className="mt-1 text-2xl font-extrabold text-[var(--app-text)]">Add Expense</h2>
              </div>
              <button
                type="button"
                onClick={closeModal}
                disabled={saving}
                className="rounded-xl p-2 text-[var(--app-muted)] transition hover:bg-[var(--app-panel-2)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSubmitExpense} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-semibold text-[var(--app-text-soft)]">Date</label>
                  <input
                    type="date"
                    value={form.date}
                    onChange={(event) => setForm((current) => ({ ...current, date: event.target.value }))}
                    className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none ring-0 transition focus:border-indigo-500"
                  />
                  {formErrors.date && <p className="mt-1 text-xs font-medium text-red-600">{formErrors.date}</p>}
                </div>

                <div>
                  <label className="mb-1 block text-sm font-semibold text-[var(--app-text-soft)]">Category</label>
                  <select
                    value={form.category}
                    onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}
                    className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500"
                  >
                    {EXPENSE_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                  {formErrors.category && <p className="mt-1 text-xs font-medium text-red-600">{formErrors.category}</p>}
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold text-[var(--app-text-soft)]">Description</label>
                <input
                  type="text"
                  value={form.description}
                  onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                  placeholder="Office rent, utilities bill, staff salaries..."
                  className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500"
                />
                {formErrors.description && <p className="mt-1 text-xs font-medium text-red-600">{formErrors.description}</p>}
              </div>

              <div>
                <label className="mb-1 block text-sm font-semibold text-[var(--app-text-soft)]">Amount (PKR)</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={form.amount}
                  onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))}
                  placeholder="0.00"
                  className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500"
                />
                {formErrors.amount && <p className="mt-1 text-xs font-medium text-red-600">{formErrors.amount}</p>}
              </div>

              {submitError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                  {submitError}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={saving}
                  className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-4 py-2.5 text-sm font-bold text-[var(--app-text)] transition hover:bg-[var(--app-panel)] disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-xl bg-[var(--app-accent)] px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:brightness-105 disabled:opacity-70"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {saving ? 'Saving...' : 'Save Expense'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {expenseToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => !deletingExpenseId && setExpenseToDelete(null)} />
          <div className="relative w-full max-w-md rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-red-600">
              <Trash2 className="h-5 w-5" />
            </div>
            <h3 className="text-center text-xl font-extrabold text-[var(--app-text)]">Delete Expense?</h3>
            <p className="mt-2 text-center text-sm text-[var(--app-muted)]">
              This will permanently remove <span className="font-bold text-[var(--app-text)]">{expenseToDelete.description}</span> from the record.
            </p>

            {deleteError && (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                {deleteError}
              </div>
            )}

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setExpenseToDelete(null)}
                disabled={deletingExpenseId}
                className="flex-1 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-4 py-2.5 text-sm font-bold text-[var(--app-text)] transition hover:bg-[var(--app-panel)] disabled:opacity-60"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handleDeleteExpense}
                disabled={deletingExpenseId}
                className="flex-1 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-red-700 disabled:opacity-70"
              >
                {deletingExpenseId ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
