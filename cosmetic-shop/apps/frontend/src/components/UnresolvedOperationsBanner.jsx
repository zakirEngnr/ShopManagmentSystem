import { useState } from 'react';
import { AlertTriangle, RefreshCw, ExternalLink, FilePlus2 } from 'lucide-react';

/**
 * The page level warning about money-writing requests with an unknown
 * outcome.
 *
 * It is shown when the dialog of the unresolved operation is NOT open - for
 * example after the user navigated away and came back, or when the operation
 * belongs to another customer or supplier of the same workflow.
 *
 * The warning never disappears on its own and it never discards the
 * unresolved state: the retry replays the original request, and the
 * abandonment needs a second, explicit confirmation.
 */
export default function UnresolvedOperationsBanner({
  label,
  records,
  busy,
  onRetry,
  onAbandon,
  onOpen,
  className = '',
}) {
  const [confirmingScope, setConfirmingScope] = useState(null);

  if (!records || records.length === 0) return null;

  return (
    <div
      role="alert"
      data-testid="unresolved-operations-banner"
      className={`rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200 ${className}`}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">
            {records.length === 1
              ? `A ${label} may already have been saved.`
              : `${records.length} ${label}s may already have been saved.`}
          </p>
          <p className="mt-1 text-xs leading-relaxed">
            The request reached the server but no confirmation came back. The transaction may already
            exist. Retry the original request, or open it and decide what to do - starting a new{' '}
            {label} does not undo a {label} that was already saved.
          </p>

          <ul className="mt-3 space-y-2">
            {records.map((record) => (
              <li
                key={record.scope}
                data-testid="unresolved-operations-banner-item"
                className="rounded-lg border border-amber-300 bg-amber-100/60 p-3 dark:bg-amber-900/25"
              >
                <p className="text-xs font-bold">{record.scope}</p>
                {record.createdAt ? (
                  <p className="text-[11px] opacity-80">
                    Request sent at {new Date(record.createdAt).toLocaleString()}
                  </p>
                ) : null}

                {confirmingScope === record.scope ? (
                  <div
                    data-testid="unresolved-operations-banner-confirm"
                    className="mt-2 rounded-lg border border-amber-400 bg-amber-100/80 p-3 dark:bg-amber-900/40"
                  >
                    <p className="text-xs font-bold leading-relaxed">
                      Start a new {label} without this request?
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed">
                      The original {label} may already have been saved on the server. This does not
                      cancel it and it does not undo it.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmingScope(null);
                          onAbandon(record.scope);
                        }}
                        disabled={busy}
                        data-testid="unresolved-operations-banner-abandon-yes"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-60"
                      >
                        <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Yes, start a new {label}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingScope(null)}
                        disabled={busy}
                        data-testid="unresolved-operations-banner-abandon-no"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400 px-3 py-1.5 text-xs font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-60 dark:text-amber-100 dark:hover:bg-amber-900/50"
                      >
                        Keep the original request
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => onRetry(record.scope)}
                      disabled={busy}
                      data-testid="unresolved-operations-banner-retry"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-700 disabled:opacity-60"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
                      Retry the original request
                    </button>
                    {onOpen ? (
                      <button
                        type="button"
                        onClick={() => onOpen(record)}
                        disabled={busy}
                        data-testid="unresolved-operations-banner-open"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400 px-3 py-1.5 text-xs font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-60 dark:text-amber-100 dark:hover:bg-amber-900/50"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        Open it
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setConfirmingScope(record.scope)}
                      disabled={busy}
                      data-testid="unresolved-operations-banner-abandon"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400 px-3 py-1.5 text-xs font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-60 dark:text-amber-100 dark:hover:bg-amber-900/50"
                    >
                      <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Start a new {label} instead
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
