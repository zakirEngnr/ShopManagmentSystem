import React from 'react';
import { AlertCircle, Loader2, Plus, X } from 'lucide-react';

const EXPENSE_CATEGORIES = ['RENT', 'SALARIES', 'UTILITIES', 'PACKAGING', 'TRANSPORT', 'MARKETING', 'OTHER'];

const formatCurrency = (value) => {
  if (value === null || value === undefined || value === '') return 'N/A';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  return `Rs. ${numeric.toLocaleString('en-PK', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
};

const getDateInputValue = (date = new Date()) => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getFormStateFromExpense = (expenseValue) => {
  const safeExpense = expenseValue ?? {};

  return {
    date: safeExpense.date ?? getDateInputValue(new Date()),
    category: safeExpense.category ?? 'OTHER',
    expenseName: safeExpense.expenseName ?? '',
    description: safeExpense.description ?? '',
    amount: String(safeExpense.amount ?? ''),
  };
};

/**A
 * Presentational expense edit modal.
 *
 * Prepopulates the form from the supplied expense and reports submission
 * state back through callbacks, so it can be rendered and tested in
 * isolation.
 *
 * @param {object} props
 * @param {object} props.expense - The expense to edit.
 * @param {Function} props.onSave - Called with the submitted values.
 * @param {Function} props.onClose - Called to close the modal.
 * @param {boolean} props.loading - Whether a save is in flight.
 * @param {string|null} props.error - A user-facing error message, if any.
 */
export default function ExpenseEditModal({
  expense,
  onSave = () => {},
  onClose = () => {},
  loading = false,
  error,
}) {
  const [form, setForm] = React.useState(() => getFormStateFromExpense(expense));
  const [formErrors, setFormErrors] = React.useState({});
  const [submitError, setSubmitError] = React.useState(null);

  React.useEffect(() => {
    setForm(getFormStateFromExpense(expense));
  }, [expense]);

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

  const handleSubmit = async (event) => {
    event.preventDefault();

    const nextErrors = validateForm(form);
    setFormErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const payload = {
      date: form.date,
      category: form.category,
      expenseName: String(form.expenseName).trim() || undefined,
      description: String(form.description).trim(),
      amount: Number(form.amount),
    };

    await onSave(payload);
  };

  const handleCancel = () => {
    onClose();
  };

  if (error) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
        <div className="relative w-full max-w-md rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Edit expense</p>
              <h2 className="mt-1 text-2xl font-extrabold text-[var(--app-text)]">Unable to save expense</h2>
            </div>
            <button type="button" onClick={onClose} className="rounded-lg p-2 text-[var(--app-muted)] transition hover:bg-[var(--app-panel-2)]">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="rounded-3xl border border-red-200 bg-red-50 p-6 text-center">
            <AlertCircle className="h-6 w-6 mx-auto mb-3 text-red-600" />
            <h3 className="text-lg font-bold text-[var(--app-text)]">Unable to save expense</h3>
            <p className="mt-2 text-sm text-[var(--app-muted)]">{error}</p>
            <button type="button" onClick={onClose} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-red-700">
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">Edit expense</p>
            <h2 className="mt-1 text-2xl font-extrabold text-[var(--app-text)]">Edit Expense</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-lg p-2 text-[var(--app-muted)] transition hover:bg-[var(--app-panel-2)] disabled:opacity-60"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-semibold text-[var(--app-text-soft)]">Date</label>
              <input
                type="date"
                value={form.date}
                onChange={(event) =>
                  setForm((current) => ({ ...current, date: event.target.value }))
                }
                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500"
              />
              {formErrors.date && <p className="mt-1 text-xs font-medium text-red-600">{formErrors.date}</p>}
            </div>

            <div>
              <label className="mb-1 block text-sm font-semibold text-[var(--app-text-soft)]">Expense Name / Payee</label>
              <input
                type="text"
                value={form.expenseName}
                onChange={(event) =>
                  setForm((current) => ({ ...current, expenseName: event.target.value }))
                }
                placeholder="e.g. Lunch, Rent, Fazil"
                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500"
              />
              <p className="mt-1 text-xs text-[var(--app-muted)]">Optional — group expenses by name/payee</p>
              {formErrors.expenseName && (
                <p className="mt-1 text-xs font-medium text-red-600">{formErrors.expenseName}</p>
              )}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-semibold text-[var(--app-text-soft)]">Category</label>
            <select
              value={form.category}
              onChange={(event) =>
                setForm((current) => ({ ...current, category: event.target.value }))
              }
              className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500"
            >
              {EXPENSE_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-semibold text-[var(--app-text-soft)]">Amount (PKR)</label>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={form.amount}
              onChange={(event) =>
                setForm((current) => ({ ...current, amount: event.target.value }))
              }
              placeholder="0.00"
              className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500"
            />
            {formErrors.amount && <p className="mt-1 text-xs font-medium text-red-600">{formErrors.amount}</p>}
          </div>

          <div>
            <label className="mb-1 block text-sm font-semibold text-[var(--app-text-soft)]">Description</label>
            <input
              type="text"
              value={form.description}
              onChange={(event) =>
                setForm((current) => ({ ...current, description: event.target.value }))
              }
              placeholder="Office rent, utilities bill, staff salaries..."
              className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500"
            />
            {formErrors.description && (
              <p className="mt-1 text-xs font-medium text-red-600">{formErrors.description}</p>
            )}
          </div>

          {submitError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              {submitError}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-4 py-2.5 text-sm font-bold text-[var(--app-text)] transition hover:bg-[var(--app-panel)] disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-xl bg-[var(--app-accent)] px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:brightness-105 disabled:opacity-70"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {loading ? 'Saving...' : 'Save Expense'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
