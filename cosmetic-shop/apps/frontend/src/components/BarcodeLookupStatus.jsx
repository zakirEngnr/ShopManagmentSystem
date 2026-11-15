import { Loader2 } from 'lucide-react';
import StatusMessage from './StatusMessage.jsx';
import { BARCODE_STATUS } from '../utils/barcodeLookup.js';

/**
 * The feedback of the barcode lookup.
 *
 * The POS shows it right next to the barcode input, where the cashier is
 * looking:
 *
 *   - looking up  - a spinner, so a scan is never mistaken for a failure;
 *   - not found   - the barcode is unknown to the catalogue;
 *   - failed      - the request itself failed (offline, server error). This
 *                   is NOT the same as "unknown barcode" and says so.
 */
export default function BarcodeLookupStatus({ state, className = '' }) {
  if (!state) return null;

  if (state.status === BARCODE_STATUS.LOOKING_UP) {
    return (
      <p
        role="status"
        aria-live="polite"
        data-testid="barcode-loading"
        className={`flex items-center gap-2 text-xs font-medium text-[var(--app-muted)] ${className}`}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Looking up barcode…
      </p>
    );
  }

  if (state.status === BARCODE_STATUS.NOT_FOUND) {
    return (
      <StatusMessage
        type="error"
        className={className}
        message={`No product found for barcode ${state.barcode}.`}
      />
    );
  }

  if (state.status === BARCODE_STATUS.FAILED) {
    return (
      <StatusMessage
        type="error"
        className={className}
        message={`Unable to look up barcode ${state.barcode}. Check the connection and try again.`}
      />
    );
  }

  return null;
}
