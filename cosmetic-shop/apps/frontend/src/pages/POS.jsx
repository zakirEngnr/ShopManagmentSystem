import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Search, Barcode, Package, AlertCircle, Loader2, Sparkles,
  ShoppingCart, Trash2, Plus, Minus, Save, CheckCircle,
  DollarSign, Smartphone, Edit2, Check, User, X,
} from 'lucide-react';
import { fetchProducts, fetchProductByBarcode } from '../api/products';
import { createSale } from '../api/sales';
import { fetchCustomers } from '../api/customers';
import { useMoneyOperation } from '../hooks/useMoneyOperation.js';
import { MONEY_OUTCOME } from '../utils/moneyOperation.js';
import { toPaisa, fromPaisa, toRupees, formatPaisa } from '../utils/money.js';
import { validateCashTender, changePaisa } from '../utils/cashTender.js';
import { createBarcodeLookup, BARCODE_STATUS, INITIAL_BARCODE_STATE } from '../utils/barcodeLookup.js';
import UnresolvedOperationNotice from '../components/UnresolvedOperationNotice.jsx';
import StatusMessage from '../components/StatusMessage.jsx';
import CatalogueState from '../components/CatalogueState.jsx';
import BarcodeLookupStatus from '../components/BarcodeLookupStatus.jsx';
import SaleChangeAmount from '../components/SaleChangeAmount.jsx';

/**
 * Scope of the POS operation. The POS has exactly one active checkout, so a
 * single scope is used: an unresolved checkout blocks every later checkout.
 */
const SALE_SCOPE = 'sale';

const PRODUCT_TYPE_FILTERS = [
  { value: '', label: 'All' },
  { value: 'COSMETIC', label: 'Cosmetic' },
  { value: 'JEWELRY', label: 'Jewelry' },
];

const PAYMENT_METHODS = [
  { value: 'CASH', label: 'Cash', icon: DollarSign },
  { value: 'JAZZCASH', label: 'JazzCash', icon: Smartphone },
  { value: 'MOBILE', label: 'Easypaisa', icon: Smartphone },
  { value: 'KHATA', label: 'Udhaar / Credit', icon: User },
];

const DEBOUNCE_MS = 300;

const formatCurrency = (value) => {
  if (value === null || value === undefined || value === '') return 'Rs. 0';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'Rs. 0';
  return `Rs. ${numeric.toLocaleString('en-PK', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
};

const validStock = (stock) => {
  if (stock == null || !Number.isFinite(Number(stock))) return 0;
  return Math.max(0, Number(stock));
};

const getImageUrl = (url) => {
  if (!url) return null;
  return url.startsWith('/uploads') 
    ? `${import.meta.env.VITE_API_URL || 'http://localhost:4000'}${url}` 
    : url;
};

export default function POS() {
  const [products, setProducts] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [productType, setProductType] = useState('');

  const [barcodeValue, setBarcodeValue] = useState('');
  // The state of the barcode lookup: idle, looking-up, found, not-found or
  // failed. It is owned by the lookup controller, which also decides what
  // happens with a repeated scan event.
  const [barcodeState, setBarcodeState] = useState({ ...INITIAL_BARCODE_STATE });

  const [cart, setCart] = useState([]);
  const [cartMessage, setCartMessage] = useState(null);
  const [cartMessageType, setCartMessageType] = useState('info');

  const [editingPriceId, setEditingPriceId] = useState(null);
  const [tempPrice, setTempPrice] = useState('');

  const [billDiscount, setBillDiscount] = useState('');
  const [billDiscountWarning, setBillDiscountWarning] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [cashReceived, setCashReceived] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [customerGroup, setCustomerGroup] = useState('retail'); // 'retail' | 'business' | 'personal'
  const [customers, setCustomers] = useState([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerLoading, setCustomerLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState(null);
  const [saleSuccess, setSaleSuccess] = useState(null);

  const debounceTimer = useRef(null);
  const productRequestId = useRef(0);
  const mounted = useRef(true);
  const barcodeInputRef = useRef(null);
  const messageTimerRef = useRef(null);


  // The idempotency key AND the payload of the current checkout. A retry of
  // the same checkout reuses both, so the backend returns the original sale
  // instead of creating a second one.
  const saleOperation = useMoneyOperation({
    scope: SALE_SCOPE,
    operation: 'POST /sales',
    label: 'sale',
    send: createSale,
  });
  const saleLocked = saleOperation.locked;

  /**
   * Show a message about the cart. It disappears on its own after a few
   * seconds, but it is also announced to a screen reader.
   */
  const showCartMessage = (message, type = 'info') => {
    setCartMessage(message);
    setCartMessageType(type);
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    messageTimerRef.current = setTimeout(() => setCartMessage(null), 4000);
  };

  const addToCart = useCallback((product) => {
    // While a checkout is unresolved its payload is frozen: changing it could
    // record a second sale.
    if (saleLocked) return;
    if (!product || !product.id) return;
    const stock = validStock(product.stock);
    const price = toPaisa(product.sellPrice);

    if (stock <= 0) return showCartMessage(`${product.name} is out of stock.`, 'error');
    if (price <= 0) return showCartMessage(`${product.name} has an invalid price.`, 'error');

    setCart((prev) => {
      const existing = prev.find((item) => item.product.id === product.id);
      if (existing) {
        if (existing.quantity >= stock) {
          showCartMessage(`Maximum stock (${stock}) reached.`, 'error');
          return prev;
        }
        return prev.map((item) =>
          item.product.id === product.id ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      showCartMessage(`${product.name} added.`, 'success');
      return [...prev, { product, quantity: 1, customPricePaisa: price }];
    });
  }, [saleLocked]);

  /**
   * A scanned product goes into the cart.
   *
   * Scanning the same product twice is a deliberate action and increases its
   * quantity (see `addToCart`); a repeated SCAN EVENT of the same barcode is
   * filtered out by the lookup controller, so it can never add the product
   * twice by accident.
   */
  const handleBarcodeFound = useCallback((product) => {
    addToCart(product);
  }, [addToCart]);

  const fetchProductList = useCallback(async (nextSearch = '', nextType = '') => {
    const currentRequestId = ++productRequestId.current;
    setListLoading(true);
    setListError(null);

    try {
      const data = await fetchProducts({
        search: nextSearch || undefined,
        type: nextType || undefined,
        limit: 50,
      });

      if (!mounted.current || currentRequestId !== productRequestId.current) return;
      setProducts(Array.isArray(data?.products) ? data.products : []);
    } catch {
      if (!mounted.current || currentRequestId !== productRequestId.current) return;
      setProducts([]);
      setListError('Unable to load products. Please try again.');
    } finally {
      if (mounted.current && currentRequestId === productRequestId.current) {
        setListLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void fetchProductList('', '');
    if (barcodeInputRef.current) barcodeInputRef.current.focus();

    return () => {
      mounted.current = false;
      productRequestId.current += 1;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    };
  }, [fetchProductList]);

  /**
   * The barcode lookup controller.
   *
   * It owns the scan events: a repeated scan event of the same barcode is
   * ignored while its lookup runs, and a different barcode waits its turn
   * instead of being dropped.
   */
  const [barcodeLookup] = useState(() =>
    createBarcodeLookup({
      lookup: fetchProductByBarcode,
      onStateChange: (next) => {
        setBarcodeState(next);

        if (next.status === BARCODE_STATUS.FOUND) {
          // Clear the input, but only when it still holds the scanned
          // barcode - a value typed in the meantime must not be wiped.
          setBarcodeValue((current) => (current.trim() === next.barcode ? '' : current));
        }
      },
    }),
  );

  // The callbacks of the controller are refreshed after every render, so the
  // controller always uses the current handlers without being recreated.
  useEffect(() => {
    barcodeLookup.configure({ onFound: handleBarcodeFound });
  });

  // The scanner keeps the focus, so the next scan goes straight into the
  // input - also after a lookup that ended in an error.
  useEffect(() => {
    if (barcodeState.status !== BARCODE_STATUS.LOOKING_UP && barcodeInputRef.current) {
      barcodeInputRef.current.focus();
    }
  }, [barcodeState]);

  // Stop the controller when the POS is left.
  useEffect(() => () => barcodeLookup.dispose(), [barcodeLookup]);


  useEffect(() => {
    if (paymentMethod !== 'KHATA') {
      setCustomers([]);
      setSelectedCustomer(null);
      setCustomerSearch('');
      return;
    }
    let cancelled = false;
    const loadCustomers = async () => {
      setCustomerLoading(true);
      try {
        let customerType;
        if (customerGroup === 'business') customerType = 'BUSINESS';
        else if (customerGroup === 'personal') customerType = 'PERSONAL';
        else customerType = 'RETAIL';
        const data = await fetchCustomers({ type: customerType });
        if (!cancelled) setCustomers(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setCustomers([]);
      } finally {
        if (!cancelled) setCustomerLoading(false);
      }
    };
    void loadCustomers();
    return () => {
      cancelled = true;
    };
  }, [paymentMethod, customerGroup]);

  const handleSearchChange = (event) => {
    const value = event.target.value;
    setSearchQuery(value);
    productRequestId.current += 1;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      void fetchProductList(value, productType);
    }, DEBOUNCE_MS);
  };

  const handleTypeChange = (nextType) => {
    setProductType(nextType);
    productRequestId.current += 1;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    void fetchProductList(searchQuery, nextType);
  };

  /**
   * Handle one scan event.
   *
   * The lookup controller decides what happens: a repeated event of the same
   * barcode is ignored while its lookup runs, a different barcode waits its
   * turn. The outcome (found, unknown barcode, failed request) is reported
   * through `barcodeState` and rendered next to the input.
   */
  const handleBarcodeLookup = (event) => {
    if (event) event.preventDefault();

    const barcode = barcodeValue.trim();
    if (!barcode) return;

    barcodeLookup.scan(barcode);
  };

  const incrementQuantity = useCallback((productId) => {
    if (saleLocked) return;
    setCart((prev) => {
      const item = prev.find((i) => i.product.id === productId);
      if (!item) return prev;
      const stock = validStock(item.product.stock);
      if (item.quantity >= stock) {
        showCartMessage(`Maximum stock (${stock}) reached.`, 'error');
        return prev;
      }
      return prev.map((i) =>
        i.product.id === productId ? { ...i, quantity: i.quantity + 1 } : i
      );
    });
  }, [saleLocked]);

  const decrementQuantity = useCallback((productId) => {
    if (saleLocked) return;
    setCart((prev) => {
      const item = prev.find((i) => i.product.id === productId);
      if (!item) return prev;
      if (item.quantity <= 1) return prev.filter((i) => i.product.id !== productId);
      return prev.map((i) =>
        i.product.id === productId ? { ...i, quantity: i.quantity - 1 } : i
      );
    });
  }, [saleLocked]);

  const removeFromCart = useCallback((productId) => {
    if (saleLocked) return;
    setCart((prev) => prev.filter((i) => i.product.id !== productId));
  }, [saleLocked]);

  /**
   * Empty the cart.
   *
   * This only clears the screen: it never touches the unresolved operation.
   * An unresolved checkout keeps its key and payload until it is retried or
   * explicitly abandoned, so clearing the cart can never silently discard it.
   */
  const clearCart = useCallback(() => {
    setCart([]);
    setBillDiscount('');
    setPaymentMethod('');
    setCashReceived('');
    setSelectedCustomer(null);
    setCustomerSearch('');
  }, []);

  const startEditingPrice = (item) => {
    setEditingPriceId(item.product.id);
    setTempPrice(toRupees(item.customPricePaisa).toString());
  };

  const saveEditedPrice = (item) => {
    if (saleLocked) return;
    const newPriceRupees = Number(tempPrice);
    if (!Number.isFinite(newPriceRupees) || newPriceRupees <= 0) {
      showCartMessage('Please enter a valid price.', 'error');
      return;
    }
    const newPricePaisa = toPaisa(newPriceRupees);
    setCart((prev) =>
      prev.map((i) =>
        i.product.id === item.product.id ? { ...i, customPricePaisa: newPricePaisa } : i
      )
    );
    setEditingPriceId(null);
    setTempPrice('');
    showCartMessage('Price updated.', 'success');
  };

  const cancelEditingPrice = () => {
    setEditingPriceId(null);
    setTempPrice('');
  };

const lineTotalPaisa = (item) => item.customPricePaisa * item.quantity;
const lineOriginalPaisa = (item) => toPaisa(item.product.sellPrice) * item.quantity;
const lineDiscountPaisa = (item) => Math.max(0, lineOriginalPaisa(item) - lineTotalPaisa(item));

const subtotalPaisa = cart.reduce((sum, item) => sum + lineOriginalPaisa(item), 0);
const itemDiscountsPaisa = cart.reduce((sum, item) => sum + lineDiscountPaisa(item), 0);
const editedSubtotalPaisa = cart.reduce((sum, item) => sum + lineTotalPaisa(item), 0);
const billDiscountPaisa = toPaisa(Number(billDiscount) || 0);
// Negotiated item prices are already reflected in `customPricePaisa`, so only the
// bill-level discount is sent to the backend as `discount`. This avoids counting
// the same price reduction twice (once via unitPrice, once via discount).
const payablePaisa = Math.max(0, editedSubtotalPaisa - billDiscountPaisa);

// The cash tender that is currently entered. It is validated once, here, and
// the result is used both by the checkout validation and by the live preview
// of the change. The comparison happens in integer paisa.
const cashTenderError = paymentMethod === 'CASH' ? validateCashTender(cashReceived, payablePaisa) : null;

// The change the current tender implies. It is null while the tender is not
// a valid amount, so the preview never shows a misleading change.
const cashChangePaisa =
  paymentMethod === 'CASH' && !cashTenderError ? changePaisa(cashReceived, payablePaisa) : null;

  const validateCheckout = () => {
    if (cart.length === 0) return 'Cart is empty.';
    if (!paymentMethod) return 'Please select a payment method.';
    if (billDiscountPaisa > editedSubtotalPaisa) return 'Discount cannot exceed subtotal.';

    if (paymentMethod === 'CASH') {
      // The tender is validated against the amount due in integer paisa. An
      // empty field, a non-number and a negative amount are all rejected, and
      // a tender below the total is rejected as well.
      if (cashTenderError) return cashTenderError;
    }

    if (paymentMethod === 'KHATA' && !selectedCustomer) {
      return 'Please select a person to record Udhaar for.';
    }
    return null;
  };

  /**
   * Apply the result of a submission to the screen.
   *
   * @param {object} outcome - The result of `saleOperation.submit()` or
   *   `saleOperation.retry()`.
   */
  const applyOutcome = (outcome) => {
    if (outcome.outcome === MONEY_OUTCOME.SENT) {
      // The server confirmed the sale: the UI is built from the values the
      // server returned, not from the form.
      const sale = outcome.result || {};
      const customer =
        sale.customerId && selectedCustomer && selectedCustomer.id === sale.customerId
          ? selectedCustomer
          : null;

      setSaleSuccess({ ...sale, customer });
      clearCart();
      // Refresh products after a confirmed successful sale so stock badges
      // reflect the decremented stock from the backend. Preserves the active
      // search and product-type filters. Errors here do not affect the sale
      // outcome, which was already confirmed successful.
      void fetchProductList(searchQuery, productType);
      setCashReceived('');
      setSelectedCustomer(null);
      setPaymentMethod('');
      setCheckoutError(null);
      return;
    }

    if (outcome.outcome === MONEY_OUTCOME.AMBIGUOUS) {
      // The request may already have been committed. The key AND the payload
      // stay pinned, the checkout is frozen until the user retries it or
      // explicitly abandons it.
      setCheckoutError(outcome.message);
      return;
    }

    // A blocked submission, a verified failure, a request that could not be
    // sent safely and a request that is already in flight all end up here.
    setCheckoutError(outcome.message);
  };

  const handleCheckout = async () => {
    if (isSubmitting) return;

    const error = validateCheckout();
    if (error) return setCheckoutError(error);

    const saleData = {
      paymentMethod,
      discount: toRupees(billDiscountPaisa),
      items: cart.map((item) => ({
        productId: item.product.id,
        quantity: item.quantity,
        unitPrice: toRupees(item.customPricePaisa), // negotiated (edited) price
      })),
      // The cash tender is sent ONLY for a cash payment. Every other method
      // omits the field entirely, and the server stores NULL for it.
      ...(paymentMethod === 'CASH'
        ? { cashReceived: fromPaisa(toPaisa(cashReceived)) }
        : {}),
      ...(paymentMethod === 'KHATA' && selectedCustomer
        ? { customerId: selectedCustomer.id }
        : {}),
    };

    setIsSubmitting(true);
    setCheckoutError(null);

    try {
      // The body is stored with the key and sent unchanged. While a checkout
      // is unresolved, a DIFFERENT body is refused instead of sent.
      const outcome = await saleOperation.submit(saleData);
      applyOutcome(outcome);
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Send the ORIGINAL request again, unchanged. */
  const handleRetrySale = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setCheckoutError(null);

    try {
      const outcome = await saleOperation.retry();
      applyOutcome(outcome);
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Explicitly start something else. The original request may already have
   * been committed - this does not undo it.
   */
  const handleAbandonSale = () => {
    saleOperation.abandon();
    clearCart();
    setCheckoutError(null);
  };

  const renderProductCard = (product, index) => {
    const imageUrl = getImageUrl(product.imageUrl);
    const displayPrice = toPaisa(product.sellPrice);
    const displayStock = validStock(product.stock);
    const canAdd = displayStock > 0;

    return (
      <div
        key={product.id}
        style={{ animationDelay: `${index * 40}ms`, animationFillMode: 'both' }}
        className={`group relative bg-[var(--app-panel)] border border-[var(--app-border)] rounded-2xl p-3 flex flex-col hover:border-indigo-400 hover:shadow-2xl hover:shadow-indigo-100 hover:-translate-y-1.5 transition-all duration-300 animate-slide-up cursor-pointer ${!canAdd && 'opacity-50 grayscale'}`}
        onClick={() => canAdd && addToCart(product)}
      >
        <div className="aspect-square w-full rounded-xl bg-[var(--app-panel-2)] flex items-center justify-center mb-3 relative overflow-hidden ring-1 ring-[var(--app-border)]">
          {imageUrl ? (
            <img src={imageUrl} alt={product.name} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" />
          ) : (
            <Package className="h-10 w-10 text-[var(--app-muted)] group-hover:text-indigo-500 transition-colors" />
          )}
          {displayStock === 0 && (
            <div className="absolute inset-0 bg-white/80 dark:bg-slate-950/70 backdrop-blur-sm flex items-center justify-center">
              <span className="bg-slate-900 text-white text-[10px] uppercase font-bold px-2 py-1 rounded-full tracking-wider">Out of Stock</span>
            </div>
          )}
        </div>
        <h3 className="text-sm font-bold text-[var(--app-text)] line-clamp-2 mb-1 group-hover:text-indigo-600 transition-colors">
          {product.name}
        </h3>
        <p className="text-[10px] text-[var(--app-muted)] mb-3 uppercase tracking-wider font-semibold truncate">SKU: {product.sku || 'N/A'}</p>
        <div className="mt-auto flex items-end justify-between border-t border-[var(--app-border)] pt-3">
          <span className="text-sm font-extrabold text-[var(--app-text)]">Rs. {toRupees(displayPrice).toLocaleString()}</span>
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${displayStock > 5 ? 'bg-green-100 text-green-700' : displayStock > 0 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
            {displayStock} left
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6 animate-fade-in font-sans rounded-[30px] border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text)] shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 flex items-center justify-center shadow-inner border border-indigo-500/20">
          <Sparkles className="h-6 w-6 text-indigo-500" />
        </div>
        <div>
          <h1 className="text-2xl font-extrabold text-[var(--app-text)] tracking-tight">Point of Sale</h1>
          <p className="text-sm text-[var(--app-muted)] font-medium">Scan barcode or search to add items.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 space-y-5">
          <div className="bg-[var(--app-panel-2)] p-4 rounded-3xl border border-[var(--app-border)] shadow-sm">
            <div className="flex flex-col lg:flex-row gap-4">
              <div className="relative flex-1 group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Barcode className="h-5 w-5 text-indigo-500" />
                </div>
                <input
                  ref={barcodeInputRef}
                  type="text"
                  placeholder="Scan barcode here..."
                  value={barcodeValue}
                  onChange={(e) => setBarcodeValue(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleBarcodeLookup(e)}
                  data-testid="pos-barcode-input"
                  className="w-full pl-12 pr-4 py-3.5 bg-[var(--app-panel)] border-2 border-[var(--app-border)] rounded-2xl focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/20 outline-none transition-all font-mono text-lg text-[var(--app-text)] placeholder:font-sans"
                  autoComplete="off"
                />
              </div>
              <div className="relative flex-1 group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Search className="h-5 w-5 text-[var(--app-muted)]" />
                </div>
                <input
                  type="search"
                  placeholder="Search by name or SKU..."
                  value={searchQuery}
                  onChange={handleSearchChange}
                  className="w-full pl-12 pr-4 py-3.5 bg-[var(--app-panel)] border-2 border-[var(--app-border)] rounded-2xl focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/20 outline-none transition-all text-[var(--app-text)]"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 mt-4 pt-4 border-t border-[var(--app-border)]">
              <span className="text-[10px] font-bold text-[var(--app-muted)] uppercase tracking-wider mr-2">Categories</span>
              {PRODUCT_TYPE_FILTERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => handleTypeChange(f.value)}
                  className={`px-4 py-1.5 text-xs font-bold rounded-xl transition-all ${productType === f.value ? 'bg-indigo-600 text-white shadow-lg' : 'bg-[var(--app-panel)] text-[var(--app-text-soft)]'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <div className="mt-3">
              <BarcodeLookupStatus state={barcodeState} />
            </div>
          </div>

          <CatalogueState
            loading={listLoading}
            error={listError}
            empty={products.length === 0}
            onRetry={() => void fetchProductList(searchQuery, productType)}
          >
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {products.map((p, i) => renderProductCard(p, i))}
            </div>
          </CatalogueState>
        </div>

        <div className="lg:col-span-4">
          <div className="bg-[var(--app-panel)] border border-[var(--app-border)] rounded-3xl shadow-xl flex flex-col h-[calc(100vh-140px)] sticky top-6 overflow-hidden">
            <div className="p-5 border-b border-[var(--app-border)] flex items-center justify-between bg-[var(--app-panel-2)]">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center">
                  <ShoppingCart className="h-4 w-4 text-indigo-600" />
                </div>
                <h2 className="text-lg font-bold text-[var(--app-text)]">Current Sale</h2>
              </div>
              <button
                onClick={clearCart}
                disabled={cart.length === 0 || saleLocked}
                title={saleLocked ? 'The unresolved checkout keeps its own details.' : undefined}
                className="text-[var(--app-muted)] hover:text-red-500 p-2 rounded-xl disabled:opacity-50"
              >
                <Trash2 className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-[var(--app-panel-2)]/60">
              <StatusMessage
                message={cartMessage}
                type={cartMessageType}
                onDismiss={() => setCartMessage(null)}
              />

              {cart.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-[var(--app-muted)]">
                  <div className="w-20 h-20 bg-[var(--app-panel)] rounded-full flex items-center justify-center mb-4 border border-[var(--app-border)]">
                    <ShoppingCart className="h-8 w-8" />
                  </div>
                  <p className="text-sm font-medium">Cart is empty</p>
                </div>
              ) : (
                cart.map((item) => {
                  const isEditing = editingPriceId === item.product.id;
                  const lineTotal = lineTotalPaisa(item);
                  const originalTotal = lineOriginalPaisa(item);
                  const discount = lineDiscountPaisa(item);
                  return (
                    <div key={item.product.id} className="flex flex-col p-3.5 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-sm animate-slide-in">
                      <div className="flex justify-between items-start mb-2">
                        <p className="text-sm font-bold text-[var(--app-text)] line-clamp-1 flex-1 pr-2">{item.product.name}</p>
                        <p className="text-sm font-extrabold text-indigo-600">Rs. {toRupees(lineTotal).toLocaleString()}</p>
                      </div>

                      <div className="flex items-center gap-2 text-xs mb-2">
                        <span className="text-[var(--app-muted)] line-through">Rs. {toRupees(originalTotal).toLocaleString()}</span>
                        {discount > 0 && (
                          <span className="text-red-500 font-bold">- Rs. {toRupees(discount).toLocaleString()}</span>
                        )}
                      </div>

                      {isEditing ? (
                        <div className="flex items-center gap-2 mb-2">
                          <input
                            type="number"
                            value={tempPrice}
                            disabled={saleLocked}
                            onChange={(e) => setTempPrice(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveEditedPrice(item);
                              if (e.key === 'Escape') cancelEditingPrice();
                            }}
                            className="w-20 px-2 py-1 text-sm bg-[var(--app-panel-2)] border border-indigo-400 rounded-lg text-[var(--app-text)] outline-none"
                            autoFocus
                          />
                          <button onClick={() => saveEditedPrice(item)} disabled={saleLocked} className="p-1 bg-green-100 text-green-700 rounded-md disabled:opacity-50"><Check className="h-4 w-4" /></button>
                          <button onClick={cancelEditingPrice} className="p-1 text-[var(--app-muted)] text-xs">Cancel</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => startEditingPrice(item)}
                          disabled={saleLocked}
                          className="text-xs text-indigo-600 hover:underline mb-2 flex items-center gap-1 w-fit"
                        >
                          <Edit2 className="h-3 w-3" /> Edit Price
                        </button>
                      )}

                      <div className="flex items-center justify-between mt-1">
                        <div className="flex items-center gap-1 bg-[var(--app-panel-2)] rounded-lg p-1 border border-[var(--app-border)]">
                          <button onClick={() => decrementQuantity(item.product.id)} disabled={saleLocked} className="w-7 h-7 flex items-center justify-center bg-[var(--app-panel)] rounded-md hover:text-red-500 disabled:opacity-50">
                            <Minus className="h-3 w-3" />
                          </button>
                          <span className="text-xs font-bold w-6 text-center">{item.quantity}</span>
                          <button onClick={() => incrementQuantity(item.product.id)} disabled={saleLocked || item.quantity >= validStock(item.product.stock)} className="w-7 h-7 flex items-center justify-center bg-[var(--app-panel)] rounded-md hover:text-indigo-600 disabled:opacity-50">
                            <Plus className="h-3 w-3" />
                          </button>
                        </div>
                        <button onClick={() => removeFromCart(item.product.id)} disabled={saleLocked} className="text-xs text-[var(--app-muted)] hover:text-red-500 underline disabled:opacity-50">
                          Remove
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="p-5 border-t border-[var(--app-border)] bg-[var(--app-panel)] space-y-3">
              <div className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--app-text-soft)]">Subtotal</span>
                  <span className="font-bold text-[var(--app-text)]">Rs. {toRupees(subtotalPaisa).toLocaleString()}</span>
                </div>
                {itemDiscountsPaisa > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-[var(--app-text-soft)]">Item Discounts</span>
                    <span className="font-bold text-red-500">- Rs. {toRupees(itemDiscountsPaisa).toLocaleString()}</span>
                  </div>
                )}
                <div className="flex justify-between items-center text-sm pt-1">
                  <span className="text-[var(--app-text-soft)]">Bill Discount</span>
                  <div className="relative w-24">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--app-muted)] text-xs font-bold">Rs</span>
                    <input
                      type="number"
                      min="0"
                      value={billDiscount}
                      disabled={saleLocked}
                      data-testid="pos-bill-discount"
                      max={editedSubtotalPaisa / 100}
                      onChange={(e) => {
                        const raw = e.target.value === '' ? '' : Number(e.target.value);
                        let nextValue = raw;
                        if (typeof nextValue === 'number' && nextValue > subtotalPaisa / 100) {
                          nextValue = subtotalPaisa / 100;
                          setBillDiscountWarning(
                            `Discount cannot exceed the subtotal (Rs. ${toRupees(subtotalPaisa).toLocaleString()}).`,
                          );
                        } else {
                          setBillDiscountWarning(null);
                        }
                        setBillDiscount(nextValue);
                        setCheckoutError(null);
                      }}
                      onPaste={(e) => {
                        e.preventDefault();
                        const text = (e.clipboardData || window.clipboardData).getData('text');
                        const raw = text === '' || text === null ? '' : Number(text);
                        let nextValue = raw;
                        if (typeof nextValue === 'number' && nextValue > subtotalPaisa / 100) {
                          nextValue = subtotalPaisa / 100;
                          setBillDiscountWarning(
                            `Discount cannot exceed the subtotal (Rs. ${toRupees(subtotalPaisa).toLocaleString()}).`,
                          );
                        } else {
                          setBillDiscountWarning(null);
                        }
                        setBillDiscount(nextValue);
                        setCheckoutError(null);
                      }}
                      className="w-full pl-7 pr-2 py-1 text-right text-sm font-bold bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-lg text-[var(--app-text)] outline-none"
                      placeholder="0"
                    />
                  </div>
                  {billDiscountWarning && (
                    <p className="text-xs text-red-600 font-medium mt-1">{billDiscountWarning}</p>
                  )}
                </div>
              </div>

              <div className="flex justify-between items-center pt-2 border-t border-[var(--app-border)]">
                <span className="text-base font-bold text-[var(--app-text)]">Total</span>
                <span className="text-3xl font-extrabold text-indigo-600">Rs. {toRupees(payablePaisa).toLocaleString()}</span>
              </div>

              <div className="grid grid-cols-3 gap-2">
                {PAYMENT_METHODS.map((m) => (
                  <button
                    key={m.value}
                    disabled={saleLocked}
                    onClick={() => {
                      setPaymentMethod(m.value);
                      setCheckoutError(null);
                      if (m.value !== 'CASH') setCashReceived('');
                      if (m.value !== 'KHATA') {
                        setSelectedCustomer(null);
                        setCustomerSearch('');
                      }
                    }}
                    className={`flex flex-col items-center justify-center gap-1.5 p-2 rounded-xl border text-xs font-bold transition-all ${paymentMethod === m.value ? 'bg-indigo-600 border-indigo-500 text-white shadow-lg' : 'bg-[var(--app-panel-2)] border-[var(--app-border)] text-[var(--app-text-soft)]'}`}
                  >
                    <m.icon className="h-4 w-4" />
                    <span>{m.label}</span>
                  </button>
                ))}
              </div>

              {paymentMethod === 'CASH' && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-[var(--app-text-soft)]">Cash Received</span>
                  <div className="relative w-24">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--app-muted)] text-xs font-bold">Rs</span>
                    <input
                      type="number"
                      min="0"
                      value={cashReceived}
                      disabled={saleLocked}
                      onChange={(e) => { setCashReceived(e.target.value); setCheckoutError(null); }}
                      className="w-full pl-7 pr-2 py-1.5 text-right text-sm font-bold bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-lg text-[var(--app-text)] outline-none"
                      placeholder="0"
                    />
                  </div>
                </div>
              )}

              {paymentMethod === 'CASH' && cashChangePaisa !== null && (
                <p className="text-xs text-[var(--app-text-soft)] text-right" data-testid="cash-change-preview">
                  Change: {formatPaisa(cashChangePaisa)}
                </p>
              )}

              {paymentMethod === 'KHATA' && (
                <div className="space-y-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--app-muted)]" />
                    <input
                      type="text"
                      placeholder="Search person by name or phone..."
                      value={customerSearch}
                      disabled={saleLocked}
                      onChange={(e) => setCustomerSearch(e.target.value)}
                      className="w-full pl-9 pr-4 py-2.5 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]"
                    />
                    {customerLoading && (
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--app-muted)]">
                        <Loader2 className="h-4 w-4 animate-spin" />
                      </span>
                    )}
                  </div>

                  <div className="flex gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => { setCustomerGroup('retail'); if (!selectedCustomer || selectedCustomer.type !== 'RETAIL') setSelectedCustomer(null); }}
                      className={`flex-1 px-3 py-2 rounded-xl text-sm font-bold transition-all ${
                        customerGroup === 'retail'
                          ? 'bg-[var(--app-accent)] text-white shadow-lg'
                          : 'bg-[var(--app-panel-2)] border border-[var(--app-border)] text-[var(--app-text-soft)]'
                      }`}
                    >
                      Retail Customer
                    </button>
                    <button
                      type="button"
                      onClick={() => { setCustomerGroup('business'); if (!selectedCustomer || selectedCustomer.type !== 'BUSINESS') setSelectedCustomer(null); }}
                      className={`flex-1 px-3 py-2 rounded-xl text-sm font-bold transition-all ${
                        customerGroup === 'business'
                          ? 'bg-[var(--app-accent)] text-white shadow-lg'
                          : 'bg-[var(--app-panel-2)] border border-[var(--app-border)] text-[var(--app-text-soft)]'
                      }`}
                    >
                      Business Customer
                    </button>
                    <button
                      type="button"
                      onClick={() => { setCustomerGroup('personal'); if (!selectedCustomer || selectedCustomer.type !== 'PERSONAL') setSelectedCustomer(null); }}
                      className={`flex-1 px-3 py-2 rounded-xl text-sm font-bold transition-all ${
                        customerGroup === 'personal'
                          ? 'bg-[var(--app-accent)] text-white shadow-lg'
                          : 'bg-[var(--app-panel-2)] border border-[var(--app-border)] text-[var(--app-text-soft)]'
                      }`}
                    >
                      Personal Customer
                    </button>
                  </div>

                  {selectedCustomer ? (
                    <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-2)]/50">
                      <div>
                        <p className="text-sm font-medium text-[var(--app-text)]">
                          {selectedCustomer.name}
                        </p>
                        <p className="text-xs text-[var(--app-muted)]">
                          {formatCurrency(selectedCustomer.balance)} Udhaar
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedCustomer(null)}
                        className="p-1.5 text-[var(--app-muted)] hover:text-red-600 transition-colors"
                        title="Remove person"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="max-h-48 overflow-y-auto border border-[var(--app-border)] rounded-lg bg-[var(--app-panel-2)]">
                      {customers.length === 0 ? (
                        <div className="px-4 py-3 text-sm text-[var(--app-muted)]">
                          {customerSearch
                            ? 'No matching people.'
                            : 'No one registered yet. Add someone from the People / Udhaar page.'}
                        </div>
                      ) : (
                        <ul>
                          {customers
                            .filter((c) =>
                              String(c.name ?? '').toLowerCase().includes(customerSearch.toLowerCase()) ||
                              String(c.phone ?? '').includes(customerSearch)
                            )
                            .slice(0, 10)
                            .map((c) => (
                              <li key={c.id}>
                                <button
                                  type="button"
                                  onClick={() => setSelectedCustomer(c)}
                                  disabled={saleLocked}
                                  className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-left hover:bg-[var(--app-panel)] transition-colors border-b border-[var(--app-border)]/50 last:border-0"
                                >
                                  <span>
                                    <span className="font-medium text-[var(--app-text)]">
                                      {c.name}
                                    </span>
                                    <br />
                                    <span className="text-xs text-[var(--app-muted)]">
                                      {c.type === 'RETAIL' ? 'Retail' : c.type === 'BUSINESS' ? 'Business' : 'Personal'} · {c.phone || 'No phone'}
                                    </span>
                                  </span>
                                  <span
                                    className={`text-xs font-bold px-2 py-0.5 rounded-full border ${
                                      c.type === 'RETAIL'
                                        ? 'bg-blue-50 text-blue-700 border-blue-100'
                                        : c.type === 'BUSINESS'
                                        ? 'bg-purple-50 text-purple-700 border-purple-100'
                                        : 'bg-emerald-50 text-emerald-700 border-emerald-100'
                                    }`}
                                  >
                                    {c.type === 'RETAIL' ? 'Retail' : c.type === 'BUSINESS' ? 'Business' : 'Personal'}
                                  </span>
                                  <span className="text-xs font-bold text-amber-600 dark:text-amber-400">
                                    {formatCurrency(c.balance)}
                                  </span>
                                </button>
                              </li>
                            ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {!selectedCustomer && (
                    <p className="text-xs text-red-600 font-medium">
                      Please select a person to record Udhaar for.
                    </p>
                  )}
                </div>
              )}

              <UnresolvedOperationNotice
                label="sale"
                unresolved={saleOperation.unresolved}
                busy={isSubmitting}
                onRetry={handleRetrySale}
                onAbandon={handleAbandonSale}
                className="mb-3"
              />

              {checkoutError && (
                <div className="p-2.5 bg-red-50 dark:bg-red-500/10 border border-red-100 rounded-lg flex items-start gap-2 text-xs text-red-600 font-medium">
                  <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  {checkoutError}
                </div>
              )}

              <button
                onClick={handleCheckout}
                disabled={cart.length === 0 || isSubmitting || saleLocked}
                data-testid="pos-checkout"
                className="w-full py-3.5 rounded-2xl bg-indigo-600 text-white font-bold text-base hover:bg-indigo-500 disabled:opacity-50 transition-all flex items-center justify-center gap-2 shadow-xl"
              >
                {isSubmitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
                {isSubmitting ? 'Processing...' : 'Checkout'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {saleSuccess && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-[var(--app-panel)] border border-[var(--app-border)] rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden animate-pop-in">
            <div className="bg-gradient-to-br from-green-500 to-emerald-600 p-8 flex flex-col items-center text-white">
              <CheckCircle className="h-16 w-16 mb-4" />
              <h2 className="text-2xl font-extrabold">Sale Complete!</h2>
              <p className="text-sm mt-1 bg-green-700/30 px-3 py-1 rounded-full">
                Invoice: {saleSuccess.invoiceNo}
              </p>
              {saleSuccess.customer && (
                <p className="text-sm mt-1 bg-blue-700/30 px-3 py-1 rounded-full">
                  Udhaar recorded for: {saleSuccess.customer.name}
                </p>
              )}
              {!saleSuccess.customer && saleSuccess.customerId ? (
                <p className="text-sm mt-1 bg-blue-700/30 px-3 py-1 rounded-full">
                  Udhaar recorded for customer #{saleSuccess.customerId}
                </p>
              ) : null}
            </div>
            <div className="p-6 space-y-4">
              <div className="flex justify-between pb-3 border-b border-[var(--app-border)]">
                <span className="text-sm text-[var(--app-muted)]">Total Paid</span>
                <span className="text-xl font-extrabold" data-testid="sale-success-total">
                  Rs. {Number(saleSuccess.total ?? 0).toLocaleString()}
                </span>
              </div>
              <SaleChangeAmount sale={saleSuccess} />
              <button
                onClick={() => setSaleSuccess(null)}
                className="w-full py-3 bg-[var(--app-panel-2)] rounded-xl font-bold hover:bg-[var(--app-panel)] border border-[var(--app-border)]"
              >
                Next Person
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}