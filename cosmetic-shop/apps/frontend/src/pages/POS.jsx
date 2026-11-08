import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Search,
  Barcode,
  Package,
  AlertCircle,
  RefreshCw,
  Loader2,
  Sparkles,
  ShoppingCart,
  Trash2,
  Plus,
  Minus,
} from 'lucide-react';
import { fetchProducts, fetchProductByBarcode } from '../api/products';

const PRODUCT_TYPE_FILTERS = [
  { value: '', label: 'All' },
  { value: 'COSMETIC', label: 'Cosmetic' },
  { value: 'JEWELRY', label: 'Jewelry' },
];

const DEBOUNCE_MS = 300;

/* ---------- Money helpers (integer paisa internally) ---------- */

const toPaisa = (price) => {
  if (price == null || !Number.isFinite(Number(price))) return 0;
  return Math.round(Number(price) * 100);
};

const toRupees = (paisa) => paisa / 100;



/* ---------- Stock validation ---------- */

const validStock = (stock) => {
  if (stock == null) return 0;
  const n = Number(stock);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
};

export default function POS() {
  /* ---------- Step 1: Product list state ---------- */
  const [products, setProducts] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [productType, setProductType] = useState('');

  /* ---------- Barcode state ---------- */
  const [barcodeValue, setBarcodeValue] = useState('');
  const [barcodeLoading, setBarcodeLoading] = useState(false);
  const [barcodeResult, setBarcodeResult] = useState(null);
  const [barcodeNotFound, setBarcodeNotFound] = useState(false);
  const [barcodeError, setBarcodeError] = useState(null);

  /* ---------- Step 2: Cart state ---------- */
  const [cart, setCart] = useState([]);
  const [cartMessage, setCartMessage] = useState(null);
  const [cartMessageType, setCartMessageType] = useState('info');

  /* ---------- Refs ---------- */
  const debounceTimer = useRef(null);
  const productRequestId = useRef(0);
  const barcodeRequestId = useRef(0);
  const mounted = useRef(true);
  const barcodeInputRef = useRef(null);
  const messageTimerRef = useRef(null);

  /* ---------- Step 1: Product list fetching ---------- */
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
      setListError(null);
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

    if (barcodeInputRef.current) {
      barcodeInputRef.current.focus();
    }

    return () => {
      mounted.current = false;
      productRequestId.current += 1;
      barcodeRequestId.current += 1;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [fetchProductList]);

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

  /* ---------- Step 1: Barcode lookup ---------- */
  const handleBarcodeLookup = async (event) => {
    if (event) event.preventDefault();

    const barcode = barcodeValue.trim();
    if (!barcode) return;

    const currentRequestId = ++barcodeRequestId.current;

    setBarcodeLoading(true);
    setBarcodeError(null);
    setBarcodeResult(null);
    setBarcodeNotFound(false);

    try {
      const product = await fetchProductByBarcode(barcode);

      if (!mounted.current || currentRequestId !== barcodeRequestId.current) return;

      if (product === null) {
        setBarcodeNotFound(true);
      } else {
        setBarcodeResult(product);
        setBarcodeValue('');
        void addToCart(product);
      }
    } catch {
      if (!mounted.current || currentRequestId !== barcodeRequestId.current) return;
      setBarcodeError('Unable to look up barcode. Please try again.');
    } finally {
      if (mounted.current && currentRequestId === barcodeRequestId.current) {
        setBarcodeLoading(false);
        if (barcodeInputRef.current) barcodeInputRef.current.focus();
      }
    }
  };

  /* ---------- Step 2: Cart functions ---------- */
  const clearCartMessage = () => {
    setCartMessage(null);
    setCartMessageType('info');
  };

  const showCartMessage = (message, type = 'info') => {
    setCartMessage(message);
    setCartMessageType(type);
    if (messageTimerRef.current) clearTimeout(messageTimerRef.current);
    messageTimerRef.current = setTimeout(clearCartMessage, 4000);
  };

  const addToCart = useCallback((product) => {
    if (!product || !product.id) return;

    const stock = validStock(product.stock);
    const price = toPaisa(product.sellPrice);

    if (stock <= 0) {
      showCartMessage(`${product.name || 'Product'} is out of stock.`, 'error');
      return;
    }

    if (price <= 0) {
      showCartMessage(`${product.name || 'Product'} has an invalid price.`, 'error');
      return;
    }

    setCart((prev) => {
      const existing = prev.find((item) => item.product.id === product.id);

      if (existing) {
        if (existing.quantity >= stock) {
          showCartMessage(
            `Maximum stock (${stock}) reached for ${product.name || 'product'}.`,
            'error'
          );
          return prev;
        }
        return prev.map((item) =>
          item.product.id === product.id
            ? { ...item, quantity: item.quantity + 1 }
            : item
        );
      }

      showCartMessage(`${product.name || 'Product'} added to cart.`, 'success');
      return [...prev, { product, quantity: 1 }];
    });
  }, []);

  const incrementQuantity = useCallback((productId) => {
    setCart((prev) => {
      const item = prev.find((i) => i.product.id === productId);
      if (!item) return prev;

      const stock = validStock(item.product.stock);
      if (item.quantity >= stock) {
        showCartMessage(
          `Maximum stock (${stock}) reached for ${item.product.name || 'product'}.`,
          'error'
        );
        return prev;
      }

      return prev.map((i) =>
        i.product.id === productId ? { ...i, quantity: i.quantity + 1 } : i
      );
    });
  }, []);

  const decrementQuantity = useCallback((productId) => {
    setCart((prev) => {
      const item = prev.find((i) => i.product.id === productId);
      if (!item) return prev;

      if (item.quantity <= 1) {
        return prev.filter((i) => i.product.id !== productId);
      }

      return prev.map((i) =>
        i.product.id === productId ? { ...i, quantity: i.quantity - 1 } : i
      );
    });
  }, []);

  const removeFromCart = useCallback((productId) => {
    setCart((prev) => prev.filter((i) => i.product.id !== productId));
  }, []);

  const clearCart = useCallback(() => {
    setCart([]);
  }, []);

  /* ---------- Step 2: Money calculations ---------- */
  const lineTotalPaisa = (item) => toPaisa(item.product.sellPrice) * item.quantity;

  const subtotalPaisa = cart.reduce((sum, item) => sum + lineTotalPaisa(item), 0);

  /* ---------- Step 1: Render product card ---------- */
  const renderProductCard = (product, index) => {
    const imageUrl = product.imageUrl || null;
    const displayName = product.name || 'Unnamed Product';
    const displaySku = product.sku || product.barcode || '';
    const displayPrice = toPaisa(product.sellPrice);
    const displayStock = validStock(product.stock);
    const inCart = cart.some((item) => item.product.id === product.id);
    const cartItem = cart.find((item) => item.product.id === product.id);
    const cartQty = cartItem ? cartItem.quantity : 0;

    const canAdd = displayStock > 0 && displayPrice > 0;
    const atMax = inCart && cartQty >= displayStock;

    const animationDelay = `${index * 50}ms`;

    return (
      <div
        key={product.id}
        style={{ animationDelay, animationFillMode: 'both' }}
        className={`group relative bg-white border border-slate-200 rounded-2xl p-4 flex flex-col hover:border-indigo-300 hover:shadow-xl hover:shadow-indigo-100 hover:-translate-y-1 transition-all duration-300 animate-slide-up cursor-pointer ${!canAdd ? 'opacity-60 cursor-not-allowed' : ''}`}
        onClick={() => {
          if (canAdd) void addToCart(product);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && canAdd) void addToCart(product);
        }}
        role="button"
        tabIndex={canAdd ? 0 : -1}
        aria-label={`Add ${displayName} to cart`}
      >
        <div className="aspect-square w-full rounded-xl bg-slate-50 flex items-center justify-center mb-4 overflow-hidden relative">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={displayName}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 ease-out"
            />
          ) : (
            <Package className="h-10 w-10 text-slate-300 group-hover:text-indigo-300 transition-colors duration-300" />
          )}
          {displayStock === 0 && (
            <div className="absolute inset-0 bg-white/70 backdrop-blur-sm flex items-center justify-center">
              <span className="bg-slate-900 text-white text-xs font-bold px-3 py-1 rounded-full">
                Out of Stock
              </span>
            </div>
          )}
          {displayStock > 0 && displayStock <= 5 && (
            <div className="absolute top-2 right-2 bg-amber-100 text-amber-700 text-[10px] font-bold px-2 py-1 rounded-md uppercase tracking-wide shadow-sm">
              Low Stock
            </div>
          )}
        </div>

        <h3 className="text-sm font-semibold text-slate-900 line-clamp-2 mb-1 group-hover:text-indigo-600 transition-colors">
          {displayName}
        </h3>
        <p className="text-[11px] text-slate-400 mb-3 uppercase tracking-wider font-medium truncate">
          {displaySku ? `SKU: ${displaySku}` : 'No SKU'}
        </p>

        <div className="mt-auto flex items-end justify-between border-t border-slate-100 pt-3">
          <div className="flex flex-col">
            <span className="text-[10px] text-slate-400 uppercase font-semibold">Price</span>
            <span className={`text-base font-bold ${canAdd ? 'text-indigo-600' : 'text-slate-800'}`}>
              Rs. {toRupees(displayPrice).toLocaleString()}
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-[10px] text-slate-400 uppercase font-semibold">Stock</span>
            <span className={`text-sm font-semibold ${displayStock > 0 ? 'text-slate-700' : 'text-red-500'}`}>
              {displayStock}
            </span>
          </div>
        </div>

        {inCart && (
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                decrementQuantity(product.id);
              }}
              className="px-2 py-1 text-xs text-slate-600 bg-white border border-slate-200 rounded hover:bg-slate-50 transition-colors"
              aria-label="Decrease quantity"
            >
              <Minus className="h-3 w-3" />
            </button>
            <span className="text-xs font-bold text-slate-900 w-4 text-center">
              {cartQty}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                incrementQuantity(product.id);
              }}
              disabled={atMax}
              className={`px-2 py-1 text-xs ${atMax ? 'text-slate-400' : 'text-indigo-600'} bg-white border rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${atMax ? 'border-slate-200' : 'border-indigo-200'}`}
              aria-label="Increase quantity"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    );
  };

  /* ---------- Step 1: Barcode result toast ---------- */
  const renderBarcodeResult = () => {
    if (barcodeResult) {
      const product = barcodeResult;
      const imageUrl = product.imageUrl || null;
      const displayName = product.name || 'Unnamed Product';
      const displayPrice = toPaisa(product.sellPrice);

      return (
        <div className="mt-4 p-4 rounded-xl border border-green-200 bg-green-50 flex items-center gap-4 animate-slide-up shadow-sm">
          <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
            <Package className="h-5 w-5 text-green-600" />
          </div>
          <div className="flex-1">
            <p className="text-xs font-semibold text-green-600 uppercase tracking-wide">
              Item Found
            </p>
            <p className="text-sm font-bold text-green-900">{displayName}</p>
            <p className="text-xs text-green-600 font-medium mt-1">
              Added to cart
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-green-600 font-medium">Price</p>
            <p className="text-sm font-bold text-green-900">
              Rs. {toRupees(displayPrice).toLocaleString()}
            </p>
          </div>
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={displayName}
              className="w-16 h-16 rounded-lg object-cover border border-green-200 bg-white"
            />
          ) : null}
        </div>
      );
    }

    if (barcodeNotFound) {
      return (
        <div className="mt-4 p-4 rounded-xl border border-red-200 bg-red-50 flex items-center gap-3 animate-shake">
          <AlertCircle className="h-5 w-5 text-red-600" />
          <p className="text-sm font-medium text-red-700">
            Product not found for barcode "{barcodeValue}".
          </p>
        </div>
      );
    }

    if (barcodeError) {
      return (
        <div className="mt-4 p-4 rounded-xl border border-red-200 bg-red-50 flex items-center gap-3">
          <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
          <p className="text-sm text-red-700">{barcodeError}</p>
        </div>
      );
    }

    return null;
  };

  /* ---------- Step 2: Render cart item ---------- */
  const renderCartItem = (item) => {
    const product = item.product;
    const displayName = product.name || 'Unnamed Product';
    const linePaisa = lineTotalPaisa(item);
    const stock = validStock(product.stock);
    const atMax = item.quantity >= stock;

    return (
      <div
        key={product.id}
        className="flex items-start justify-between gap-3 pt-4 pb-2 border-b border-slate-100 last:border-0"
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-900 line-clamp-1">
            {displayName}
          </p>
          <p className="text-xs text-slate-500 truncate">
            SKU: {product.sku || product.barcode || 'N/A'}
          </p>
        </div>

        <div className="flex flex-col items-end gap-1">
          <p className="text-sm font-semibold text-slate-800">
            Rs. {toRupees(linePaisa).toLocaleString()}
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => decrementQuantity(product.id)}
              className="w-7 h-7 rounded-lg border border-slate-200 bg-white text-slate-600 text-xs font-bold flex items-center justify-center hover:bg-slate-50 transition-colors"
              aria-label={`Decrease ${displayName}`}
            >
              <Minus className="h-3 w-3" />
            </button>
            <span className="w-6 text-center text-xs font-bold text-slate-800">
              {item.quantity}
            </span>
            <button
              onClick={() => incrementQuantity(product.id)}
              disabled={atMax}
              className={`w-7 h-7 rounded-lg border bg-white text-xs font-bold flex items-center justify-center transition-colors ${atMax ? 'border-slate-200 text-slate-400 disabled:opacity-50 disabled:cursor-not-allowed' : 'border-indigo-200 text-indigo-600 hover:bg-indigo-50'}`}
              aria-label={`Increase ${displayName}`}
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
          <button
            onClick={() => removeFromCart(product.id)}
            className="mt-1 text-xs text-red-500 hover:text-red-700 underline hover:underline underline-offset-4"
            aria-label={`Remove ${displayName}`}
          >
            Remove
          </button>
        </div>
      </div>
    );
  };

  /* ---------- Step 2: Render cart panel ---------- */
  const renderCartPanel = () => {
    const isEmpty = cart.length === 0;

    return (
      <div className="lg:col-span-4 flex flex-col h-full min-h-[600px]">
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm flex flex-col h-full overflow-hidden">
          <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50">
            <div className="flex items-center gap-2">
              <ShoppingCart className="h-5 w-5 text-indigo-600" />
              <h2 className="text-lg font-bold text-slate-900">Current Sale</h2>
            </div>
            <button
              onClick={clearCart}
              disabled={isEmpty}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                isEmpty
                  ? 'text-slate-400 bg-slate-100 border border-slate-200 disabled:opacity-50 disabled:cursor-not-allowed'
                  : 'text-red-600 bg-red-50 border border-red-100 hover:bg-red-100 hover:text-red-700'
              }`}
              aria-label="Clear cart"
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Clear
            </button>
          </div>

          {cartMessage && (
            <div className={`px-4 py-3 ${
              cartMessageType === 'success'
                ? 'bg-green-50 border border-green-100 text-green-700'
                : cartMessageType === 'error'
                  ? 'bg-red-50 border border-red-100 text-red-700'
                  : 'bg-slate-50 border border-slate-100 text-slate-700'
            }`}>
              <div className="flex items-start gap-2 text-sm">
                {cartMessageType === 'success' ? (
                  <Package className="h-4 w-4 mt-0.5 text-green-600 flex-shrink-0" />
                ) : cartMessageType === 'error' ? (
                  <AlertCircle className="h-4 w-4 mt-0.5 text-red-600 flex-shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 mt-0.5 text-slate-500 flex-shrink-0" />
                )}
                <p className="font-medium">{cartMessage}</p>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-4 space-y-1">
            {isEmpty ? (
              <div className="flex flex-col items-center justify-center py-12 text-slate-400">
                <ShoppingCart className="h-8 w-8 text-slate-300 mb-3" />
                <p className="text-sm font-medium">Cart is empty.</p>
                <p className="text-xs text-slate-400 mt-1">
                  Scan or click items to start.
                </p>
              </div>
            ) : (
              cart.map((item, index) => renderCartItem(item, index))
            )}
          </div>

          <div className="p-5 border-t border-slate-100 bg-white">
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-slate-600">Subtotal</span>
                <span className="font-semibold text-slate-900">
                  Rs. {toRupees(subtotalPaisa).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between text-sm font-bold pt-2 border-t border-slate-100">
                <span className="text-indigo-600">Total</span>
                <span className="text-indigo-600">
                  Rs. {toRupees(subtotalPaisa).toLocaleString()}
                </span>
              </div>
            </div>

            <button
              disabled
              className="w-full py-3 rounded-lg border border-slate-200 bg-slate-100 text-slate-500 text-sm font-semibold flex items-center justify-center gap-2 cursor-not-allowed hover:bg-slate-100 transition-colors"
            >
              <ShoppingCart className="h-4 w-4" />
              Checkout (Coming Soon)
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-0">
      {/* Page header */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center">
            <Sparkles className="h-5 w-5 text-indigo-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
              Point of Sale
            </h1>
            <p className="text-sm text-slate-500">
              Scan a barcode or search to add items to the current sale.
            </p>
          </div>
        </div>
      </div>

      {/* Two-column layout: product browsing (left) | cart (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT: Product browsing */}
        <div className="lg:col-span-8 space-y-6">
          {/* Barcode & Search Bar Section */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm relative overflow-hidden">
            <div className="flex flex-col lg:flex-row gap-4">
              <div className="flex-1">
                <div className="flex gap-2">
                  <div className="relative group flex-1">
                    <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                      <Barcode className="h-5 w-5 text-slate-400 group-focus-within:text-indigo-500 transition-colors" />
                    </div>
                    <input
                      ref={barcodeInputRef}
                      type="text"
                      placeholder="Scan barcode here or press Enter..."
                      value={barcodeValue}
                      onChange={(e) => setBarcodeValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleBarcodeLookup(e);
                      }}
                      onBlur={(e) => e.target.focus()}
                      className="w-full pl-11 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all duration-300 text-slate-900 font-mono text-lg placeholder:font-sans placeholder:text-base"
                      autoComplete="off"
                    />
                  </div>
                  <button
                    onClick={handleBarcodeLookup}
                    disabled={barcodeLoading || !barcodeValue.trim()}
                    className="px-6 py-3 text-sm font-semibold text-white bg-slate-900 rounded-xl hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 flex items-center gap-2 whitespace-nowrap"
                  >
                    {barcodeLoading ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <Barcode className="h-5 w-5" />
                    )}
                    {barcodeLoading ? ' Looking up...' : 'Lookup'}
                  </button>
                </div>
              </div>

              <div className="flex-1 relative group mt-4 lg:mt-0">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Search className="h-5 w-5 text-slate-400 group-focus-within:text-indigo-500 transition-colors" />
                </div>
                <input
                  type="search"
                  placeholder="Search by name or SKU..."
                  value={searchQuery}
                  onChange={handleSearchChange}
                  className="w-full pl-11 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all duration-300 text-slate-900"
                  autoComplete="off"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 mt-4 pt-4 border-t border-slate-100">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider mr-2">
                Filter
              </span>
              {PRODUCT_TYPE_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  onClick={() => handleTypeChange(filter.value)}
                  className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-all duration-200 ${
                    productType === filter.value
                      ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200 scale-105'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>

          {renderBarcodeResult()}

          {/* Product Grid */}
          <div>
            {listLoading ? (
              <div className="flex flex-col items-center justify-center py-24 text-slate-400">
                <Loader2 className="h-8 w-8 animate-spin mb-4 text-indigo-500" />
                <p className="font-medium">Loading inventory...</p>
              </div>
            ) : listError ? (
              <div className="p-12 rounded-3xl border-2 border-dashed border-red-200 bg-red-50/50 text-center">
                <AlertCircle className="h-10 w-10 text-red-400 mx-auto mb-3" />
                <p className="text-red-700 font-medium mb-4">{listError}</p>
                <button
                  onClick={() => fetchProductList(searchQuery, productType)}
                  className="px-4 py-2 bg-white border border-red-200 text-red-600 rounded-lg text-sm font-semibold hover:bg-red-50 transition-colors"
                >
                  <RefreshCw className="h-4 w-4 inline mr-2" /> Try Again
                </button>
              </div>
            ) : products.length === 0 ? (
              <div className="p-12 rounded-3xl border-2 border-dashed border-slate-200 bg-slate-50/50 text-center">
                <Search className="h-10 w-10 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-500 font-medium">No products found.</p>
                <p className="text-sm text-slate-400 mt-1">
                  Try adjusting your search or filters.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-6">
                {products.map((product, index) => renderProductCard(product, index))}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: Cart panel */}
        {renderCartPanel()}
      </div>
    </div>
  );
}
