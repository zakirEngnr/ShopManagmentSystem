import { AlertCircle, Loader2, Package, RefreshCw } from 'lucide-react';

/**
 * The state of the product catalogue.
 *
 * The three states are kept apart on purpose:
 *
 *   - loading  - the request is running;
 *   - error    - the request FAILED. The catalogue is unknown, so the empty
 *                message must not be shown ("no products found" would be a
 *                lie) and a retry is offered;
 *   - empty    - the request succeeded and the catalogue really is empty.
 */
export default function CatalogueState({
  loading,
  error,
  empty,
  onRetry,
  emptyMessage = 'No products found.',
  loadingMessage = 'Loading products…',
  errorMessage = 'Unable to load the product catalogue.',
  className = '',
  children,
}) {
  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="catalogue-loading"
        className={`flex flex-col items-center justify-center gap-3 py-24 text-[var(--app-muted)] ${className}`}
      >
        <Loader2 className="h-10 w-10 animate-spin text-indigo-500" aria-hidden="true" />
        <p className="text-sm font-medium">{loadingMessage}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        data-testid="catalogue-error"
        className={`flex flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-red-200 bg-red-50/60 py-20 text-center dark:border-red-900/50 dark:bg-red-950/20 ${className}`}
      >
        <AlertCircle className="h-10 w-10 text-red-500" aria-hidden="true" />
        <p className="text-sm font-bold text-red-700 dark:text-red-300">{errorMessage}</p>
        {typeof error === 'string' && error ? (
          <p className="max-w-sm text-xs text-red-600 dark:text-red-400">{error}</p>
        ) : null}
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            data-testid="catalogue-retry"
            className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-red-700"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Try again
          </button>
        ) : null}
      </div>
    );
  }

  if (empty) {
    return (
      <div
        data-testid="catalogue-empty"
        className={`flex flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-[var(--app-border)] py-24 text-center text-[var(--app-muted)] ${className}`}
      >
        <Package className="h-12 w-12" aria-hidden="true" />
        <p className="text-[var(--app-muted)] font-medium">{emptyMessage}</p>
      </div>
    );
  }

  return children;
}
