/**
 * The barcode lookup of the POS.
 *
 * A barcode scanner behaves like a keyboard: it types the barcode and
 * presses Enter. Two things follow from that, and both are handled here:
 *
 *   - The SAME scan event can arrive twice. The scanner repeats it, the
 *     keyboard wedge sends it again, the cashier hits Enter twice. A
 *     repeated event must not fire a second request AND must not throw away
 *     the answer of the first one - otherwise the scanned product is lost.
 *   - Two DIFFERENT barcodes in a row are two deliberate scans. The second
 *     one must not be dropped either, so it waits for the running lookup
 *     instead of replacing it.
 *
 * The controller is framework agnostic, so the rules can be tested without a
 * browser.
 */

/** The state of the barcode lookup. */
export const BARCODE_STATUS = Object.freeze({
  IDLE: 'idle',
  LOOKING_UP: 'looking-up',
  FOUND: 'found',
  NOT_FOUND: 'not-found',
  FAILED: 'failed',
});

/** The initial state: nothing has been looked up yet. */
export const INITIAL_BARCODE_STATE = Object.freeze({
  status: BARCODE_STATUS.IDLE,
  barcode: null,
  product: null,
  error: null,
});

/**
 * Create the controller of the barcode lookup.
 *
 * @param {object} options
 * @param {Function} options.lookup - `async (barcode) => product | null`.
 *   It returns null when no product carries the barcode and throws when the
 *   request failed.
 * @param {Function} [options.onStateChange] - Called with the new state after
 *   every transition.
 */
export function createBarcodeLookup({ lookup, onStateChange } = {}) {
  let state = { ...INITIAL_BARCODE_STATE };
  let pending = null; // the barcode whose lookup is running
  let queued = null; // a barcode waiting for the running lookup to end
  let disposed = false;

  // The callbacks of the owner of the controller. They are set through
  // `configure` so the owner can replace them without recreating the
  // controller.
  const handlers = {
    lookup: typeof lookup === 'function' ? lookup : async () => null,
    onFound: null,
  };

  function setState(next) {
    state = { ...state, ...next };
    if (!disposed && typeof onStateChange === 'function') onStateChange(state);
  }

  async function run(barcode) {
    pending = barcode;
    // The previous outcome is cleared when a new lookup begins, so a stale
    // error never sits next to a running lookup.
    setState({ status: BARCODE_STATUS.LOOKING_UP, barcode, product: null, error: null });

    try {
      const product = await handlers.lookup(barcode);

      if (disposed) return;

      if (product === null || product === undefined) {
        setState({ status: BARCODE_STATUS.NOT_FOUND, barcode, product: null, error: null });
        return;
      }

      setState({ status: BARCODE_STATUS.FOUND, barcode, product, error: null });

      if (typeof handlers.onFound === 'function') {
        handlers.onFound(product, barcode);
      }
    } catch (error) {
      if (disposed) return;
      // The exception is kept, never swallowed: the UI shows what went
      // wrong instead of pretending the barcode was simply unknown.
      setState({ status: BARCODE_STATUS.FAILED, barcode, product: null, error });
    } finally {
      if (pending === barcode) pending = null;

      const next = queued;
      queued = null;
      if (next && !disposed) void run(next);
    }
  }

  return {
    /**
     * Replace the callbacks of the controller.
     *
     * @param {object} next
     * @param {Function} [next.lookup] - `async (barcode) => product | null`.
     * @param {Function} [next.onFound] - `(product, barcode) => void`.
     */
    configure(next) {
      if (typeof next?.lookup === 'function') handlers.lookup = next.lookup;
      if (typeof next?.onFound === 'function') handlers.onFound = next.onFound;
      return this;
    },
    /** The current state. */
    getState: () => state,

    /** True while a lookup is running. */
    isBusy: () => pending !== null,

    /** The barcode whose lookup is running, or null. */
    pendingBarcode: () => pending,

    /**
     * Handle one scan event.
     *
     * @param {string} rawBarcode - The scanned barcode.
     * @returns {{action: 'started'|'queued'|'ignored', reason?: string, barcode?: string}}
     *   `ignored` with reason `duplicate` means the very same barcode is
     *   already being looked up.
     */
    scan(rawBarcode) {
      const barcode = String(rawBarcode ?? '').trim();

      if (!barcode) return { action: 'ignored', reason: 'empty' };
      if (disposed) return { action: 'ignored', reason: 'disposed' };

      if (pending === barcode) {
        // A repeated scan event of the same barcode: no second request, and
        // the running lookup keeps the answer it is going to deliver.
        return { action: 'ignored', reason: 'duplicate' };
      }

      if (pending) {
        // A different barcode: it waits for the running lookup, so no scan
        // is ever lost.
        queued = barcode;
        return { action: 'queued', barcode };
      }

      void run(barcode);
      return { action: 'started', barcode };
    },

    /** Forget everything and stop any pending work. */
    dispose() {
      disposed = true;
      pending = null;
      queued = null;
      state = { ...INITIAL_BARCODE_STATE };
    },
  };
}

export default { createBarcodeLookup, BARCODE_STATUS, INITIAL_BARCODE_STATE };
