import { AlertCircle, CalendarDays, Loader2, RefreshCw, Tag, X } from 'lucide-react';

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
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
};

/**
 * Presentational purchase detail modal.
 *
 * Receives all state as props so it can be rendered and tested in isolation.
 * Historical values (unit cost, line totals) come from the backend and are
 * never reconstructed from current product prices.
 *
 * @param {object} props
 * @param {object|null} props.purchase - The purchase (with supplier + items),
 *   or null when none is selected.
 * @param {boolean} props.loading - Whether a fetch is in flight.
 * @param {string|null} props.error - A user-facing error message, if any.
 * @param {Function} props.onClose - Called to close the modal.
 * @param {Function} props.onRetry - Called to retry the fetch.
 */
export default function PurchaseDetailModal({
  purchase,
  loading,
  error,
  onClose,
  onRetry,
}) {
  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
          onClick={onClose}
        />
        <div className="relative w-full max-w-3xl rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">
                Purchase detail
              </p>
              <h2 className="mt-1 text-2xl font-extrabold text-[var(--app-text)]">
                Loading…
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled
              className="rounded-lg p-2 text-[var(--app-muted)] transition hover:bg-[var(--app-panel-2)] disabled:opacity-60"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex items-center justify-center gap-3 py-24 text-[var(--app-text-soft)]">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="font-medium">Loading purchase…</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
          onClick={onClose}
        />
        <div className="relative w-full max-w-3xl rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in">
          <div className="mb-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">
                Purchase detail
              </p>
              <h2 className="mt-1 text-2xl font-extrabold text-[var(--app-text)]">
                Unable to load purchase
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-[var(--app-muted)] transition hover:bg-[var(--app-panel-2)]"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="rounded-3xl border border-red-200 bg-red-50 p-6 text-center">
            <AlertCircle className="h-6 w-6 mx-auto mb-3 text-red-600" />
            <h3 className="text-lg font-bold text-[var(--app-text)]">Unable to load purchase</h3>
            <p className="mt-2 text-sm text-[var(--app-muted)]">{error}</p>
            <button
              type="button"
              onClick={() => {
                onClose();
                if (typeof onRetry === 'function') onRetry();
              }}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-red-700"
            >
              <RefreshCw className="h-4 w-4" />
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!purchase) return null;

  const subtotal = Number(purchase.totalAmount || 0);
  const paidAmount = Number(purchase.paidAmount || 0);
  const outstanding = Math.max(0, subtotal - paidAmount);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-3xl rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--app-muted)]">
              Purchase detail
            </p>
            <h2 className="mt-1 text-2xl font-extrabold text-[var(--app-text)]">
              Purchase #{purchase.id}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-[var(--app-muted)] transition hover:bg-[var(--app-panel-2)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] p-5">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--app-text-soft)]">Supplier</p>
              <p className="font-semibold text-[var(--app-text)]">
                {purchase.supplier?.name || 'Unknown supplier'}
              </p>
              {purchase.supplier?.phone && (
                <p className="mt-1 text-xs text-[var(--app-text-soft)]">
                  {purchase.supplier.phone}
                </p>
              )}
            </div>
            <div className="mt-4 lg:mt-0 flex items-center gap-4">
              <div className="flex items-center gap-2">
                <CalendarDays className="h-4 w-4 text-[var(--app-muted)]" />
                <p className="text-sm text-[var(--app-text-soft)]">
                  {formatDate(purchase.createdAt)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Tag className="h-4 w-4 text-[var(--app-muted)]" />
                <p className="text-sm text-[var(--app-text-soft)]">
                  Reference: {purchase.idempotencyKey || '—'}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] p-5">
          <div className="grid gap-3 text-sm md:grid-cols-3">
            <div>
              <p className="text-[var(--app-muted)]">Subtotal</p>
              <p className="font-semibold text-[var(--app-text)]">
                {formatCurrency(subtotal)}
              </p>
            </div>
            <div>
              <p className="text-[var(--app-muted)]">Paid</p>
              <p className="font-semibold text-[var(--app-text)]">
                {formatCurrency(paidAmount)}
              </p>
            </div>
            <div>
              <p className="text-[var(--app-muted)]">Outstanding</p>
              <p className="font-semibold text-[var(--app-text)]">
                {formatCurrency(outstanding)}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-[var(--app-text)]">Items</h3>
            <p className="text-xs font-medium text-[var(--app-text-soft)]">
              {(purchase.items?.length ?? 0)} line item{
                (purchase.items?.length ?? 0) !== 1 ? 's' : ''
              }
            </p>
          </div>
          <div className="divide-y divide-[var(--app-border)]">
            {(purchase.items ?? []).map((item) => {
              const product = item.product;
              const lineTotal =
                item.total ?? Number(item.quantity) * Number(item.unitCost);
              return (
                <div key={item.id} className="py-4 flex items-center gap-4">
                  <div className="min-w-[120px]">
                    <p className="text-sm font-medium text-[var(--app-text)]">
                      {product?.name || 'Unknown product'}
                    </p>
                    <p className="mt-1 text-xs text-[var(--app-text-soft)]">
                      SKU: {product?.sku || '—'}
                      {product?.barcode ? ` · Barcode: ${product.barcode}` : ''}
                    </p>
                  </div>
                  <div className="flex-1 grid gap-2 text-sm md:grid-cols-3">
                    <div>
                      <p className="text-[var(--app-text-soft)]">Qty</p>
                      <p className="font-semibold text-[var(--app-text)]">
                        {item.quantity}
                      </p>
                    </div>
                    <div>
                      <p className="text-[var(--app-text-soft)]">Unit cost</p>
                      <p className="font-semibold text-[var(--app-text)]">
                        {formatCurrency(item.unitCost)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[var(--app-text-soft)]">Line total</p>
                      <p className="font-semibold text-[var(--app-text)]">
                        {formatCurrency(lineTotal)}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
