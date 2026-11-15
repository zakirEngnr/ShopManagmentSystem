import { useReducer } from 'react';
import { AlertTriangle, RefreshCw, FilePlus2 } from 'lucide-react';
import {
  abandonConfirmationReducer,
  isAbandonConfirming,
  ABANDON_IDLE,
} from '../utils/moneyOperation.js';

/**
 * Shown while a money-writing request has an unknown outcome.
 *
 * The request reached the server but no confirmation came back, so the
 * transaction MAY already have been saved. The only safe actions are:
 *
 *   - retry the ORIGINAL request (same body, same key), which the backend
 *     turns into the original transaction instead of a second one; or
 *   - explicitly start something else, knowing that this does not undo a
 *     transaction that was already saved.
 *
 * The abandonment needs a second, explicit confirmation: a single click on
 * "Start a new ..." must never be enough to throw away the only record that
 * the original request is still unresolved.
 */
export default function UnresolvedOperationNotice({
  label,
  unresolved,
  busy,
  onRetry,
  onAbandon,
  className = '',
}) {
  // The abandonment needs a second, explicit action. The state machine is
  // shared with the tests, so the two step behaviour is verified there.
  const [confirmation, dispatch] = useReducer(abandonConfirmationReducer, {
    status: ABANDON_IDLE,
    key: null,
  });

  if (!unresolved) return null;

  const confirming = isAbandonConfirming(confirmation, unresolved.key);

  return (
    <div
      role="alert"
      data-testid="unresolved-operation-notice"
      className={`rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200 ${className}`}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">This {label} may already have been saved.</p>
          <p className="mt-1 text-xs leading-relaxed">
            The request reached the server but no confirmation came back, so the {label} may already
            exist. Do not change the details and submit again &mdash; that could record it twice.
            Retry the original request, or start a new {label} instead.
          </p>

          {unresolved.createdAt ? (
            <p className="mt-1 text-[11px] opacity-80">
              Original request sent at {new Date(unresolved.createdAt).toLocaleString()}
            </p>
          ) : null}

          {confirming ? (
            <div
              data-testid="unresolved-operation-abandon-confirm"
              className="mt-3 rounded-lg border border-amber-400 bg-amber-100/70 p-3 dark:bg-amber-900/30"
            >
              <p className="text-xs font-bold leading-relaxed">
                Start a new {label} without the original request?
              </p>
              <p className="mt-1 text-[11px] leading-relaxed">
                The original {label} may already have been saved on the server. This does not cancel
                it and it does not undo it. If you are not sure, retry the original request instead.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onAbandon}
                  disabled={busy}
                  data-testid="unresolved-operation-abandon-confirm-yes"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-60"
                >
                  <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Yes, start a new {label}
                </button>
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'cancel' })}
                  disabled={busy}
                  data-testid="unresolved-operation-abandon-confirm-no"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400 px-3 py-1.5 text-xs font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-60 dark:text-amber-100 dark:hover:bg-amber-900/50"
                >
                  Keep the original request
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onRetry}
                disabled={busy}
                data-testid="unresolved-operation-retry"
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-700 disabled:opacity-60"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
                Retry the original request
              </button>
              <button
                type="button"
                onClick={() => dispatch({ type: 'request', key: unresolved.key })}
                disabled={busy}
                data-testid="unresolved-operation-abandon"
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400 px-3 py-1.5 text-xs font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-60 dark:text-amber-100 dark:hover:bg-amber-900/50"
              >
                <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
                Start a new {label} instead
              </button>
            </div>
          )}

          <p className="mt-2 text-[11px] leading-relaxed opacity-90">
            Starting a new {label} does not undo a {label} that was already saved.
          </p>
        </div>
      </div>
    </div>
  );
}
