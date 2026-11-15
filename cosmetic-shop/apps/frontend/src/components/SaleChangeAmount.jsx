import { changeFromSale } from '../utils/cashTender.js';
import { formatPaisa } from '../utils/money.js';

/**
 * The change that is handed back to the customer after a cash sale.
 *
 * The sale that the SERVER confirmed is the authority: the change is derived
 * from the tender the server stored and the total it computed, so an
 * idempotent retry shows exactly the same change as the original sale.
 *
 * A sale that was not paid in cash has no tender and therefore no change, and
 * nothing is rendered for it.
 *
 * @param {object} props
 * @param {object|null|undefined} props.sale - the confirmed sale.
 */
export default function SaleChangeAmount({ sale }) {
  const change = changeFromSale(sale);
  if (change === null) return null;

  return (
    <div className="flex justify-between" data-testid="sale-success-change-row">
      <span className="text-sm text-[var(--app-muted)]">Change</span>
      <span className="text-xl font-extrabold text-emerald-600" data-testid="sale-success-change">
        {formatPaisa(change)}
      </span>
    </div>
  );
}
