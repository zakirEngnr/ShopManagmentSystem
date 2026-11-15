import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

/**
 * A short feedback message.
 *
 * The type decides how it is announced: an error is an alert (assertive),
 * everything else is a status (polite). Screen readers therefore hear the
 * message, and the POS never leaves a message silently on the screen.
 */
export default function StatusMessage({
  message,
  type = 'info',
  className = '',
  onDismiss,
}) {
  if (!message) return null;

  const isError = type === 'error';
  const isSuccess = type === 'success';

  const tone = isError
    ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-300'
    : isSuccess
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-900/20 dark:text-emerald-300'
      : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200';

  const Icon = isError ? AlertCircle : isSuccess ? CheckCircle2 : Info;

  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      data-testid={`status-message-${type}`}
      className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs font-medium ${tone} ${className}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 break-words">{message}</span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss message"
          data-testid="status-message-dismiss"
          className="shrink-0 rounded-md p-0.5 opacity-70 transition hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}
