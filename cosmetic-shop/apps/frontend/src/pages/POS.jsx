import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Search,
  Barcode,
  Package,
  AlertCircle,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import { fetchProducts, fetchProductByBarcode } from '../api/products';

const PRODUCT_TYPE_FILTERS = [
  { value: '', label: 'All' },
  { value: 'COSMETIC', label: 'Cosmetic' },
  { value: 'JEWELRY', label: 'Jewelry' },
];

const DEBOUNCE_MS = 300;

export default function POS() {
  const [products, setProducts] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [productType, setProductType] = useState('');

  const [barcodeValue, setBarcodeValue] = useState('');
  const [barcodeLoading, setBarcodeLoading] = useState(false);
  const [barcodeResult, setBarcodeResult] = useState(null);
  const [barcodeNotFound, setBarcodeNotFound] = useState(false);
  const [barcodeError, setBarcodeError] = useState(null);

  const debounceTimer = useRef(null);
  const requestId = useRef(0);
  const mounted = useRef(true);

  const fetchProductList = useCallback(async () => {
    const currentRequestId = ++requestId.current;

    try {
      const data = await fetchProducts({
        search: searchQuery || undefined,
        type: productType || undefined,
        limit: 50,
      });

      if (!mounted.current || currentRequestId !== requestId.current) {
        return;
      }

      setProducts(data.products ?? []);
      setListError(null);
    } catch {
      if (!mounted.current || currentRequestId !== requestId.current) {
        return;
      }

      setListError('Unable to load products. Please try again.');
      setProducts([]);
    } finally {
      if (mounted.current && currentRequestId === requestId.current) {
        setListLoading(false);
      }
    }
  }, [searchQuery, productType]);

  useEffect(() => {
    mounted.current = true;
    setListLoading(true);
    setListError(null);
    fetchProductList();
    return () => {
      mounted.current = false;
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, [fetchProductList]);

  const handleSearchChange = (event) => {
    const value = event.target.value;
    setSearchQuery(value);

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    debounceTimer.current = setTimeout(() => {
      setListLoading(true);
      setListError(null);
      requestId.current = ++requestId.current;
      fetchProductList();
    }, DEBOUNCE_MS);
  };

  const handleTypeChange = (event) => {
    setProductType(event.target.value);
    setListLoading(true);
    setListError(null);
    requestId.current = ++requestId.current;
    fetchProductList();
  };

  const handleBarcodeLookup = async (event) => {
    if (event) {
      event.preventDefault();
    }

    const barcode = barcodeValue.trim();
    if (!barcode) return;

    setBarcodeLoading(true);
    setBarcodeError(null);
    setBarcodeResult(null);
    setBarcodeNotFound(false);

    try {
      const product = await fetchProductByBarcode(barcode);

      if (!mounted.current) return;

      if (product === null) {
        setBarcodeNotFound(true);
        setBarcodeResult(null);
      } else {
        setBarcodeResult(product);
        setBarcodeNotFound(false);
      }
    } catch {
      if (!mounted.current) return;

      setBarcodeError('Unable to look up barcode. Please try again.');
      setBarcodeResult(null);
      setBarcodeNotFound(false);
    } finally {
      if (mounted.current) {
        setBarcodeLoading(false);
      }
    }
  };

  const handleRetry = () => {
    setListError(null);
    requestId.current = ++requestId.current;
    fetchProductList();
  };

  const renderProductCard = (product) => {
    const imageUrl = product.imageUrl || null;
    const displayName = product.name || 'Unnamed Product';
    const displaySku = product.sku || product.barcode || '';
    const displayPrice = product.sellPrice != null ? product.sellPrice : 0;
    const displayStock = product.stock != null ? product.stock : '-';

    return (
      <div
        key={product.id}
        className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col"
      >
        <div className="aspect-square w-full rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center mb-3 overflow-hidden">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={displayName}
              className="w-full h-full object-cover"
            />
          ) : (
            <Package className="h-8 w-8 text-slate-400" />
          )}
        </div>
        <h3 className="text-sm font-medium text-slate-900 truncate">
          {displayName}
        </h3>
        <p className="text-xs text-slate-500 mb-2 truncate">
          {displaySku ? `SKU: ${displaySku}` : 'No SKU'}
        </p>
        <div className="mt-auto flex items-baseline gap-2">
          <span className="text-sm font-semibold text-indigo-600">
            PKR {displayPrice.toLocaleString()}
          </span>
          <span className="text-xs text-slate-500">
            Stock: {displayStock}
          </span>
        </div>
      </div>
    );
  };

  const renderBarcodeResult = () => {
    if (barcodeResult) {
      const product = barcodeResult;
      const imageUrl = product.imageUrl || null;
      const displayName = product.name || 'Unnamed Product';
      const displayPrice = product.sellPrice != null ? product.sellPrice : 0;

      return (
        <div
          className="mt-4 p-4 rounded-lg border border-green-200 bg-green-50 flex items-start gap-3"
        >
          <div className="flex-shrink-0 mt-0.5">
            <Package className="h-5 w-5 text-green-600" />
          </div>
          <div className="flex-1">
            <h4 className="text-sm font-semibold text-green-800">
              Product found
            </h4>
            <p className="text-sm text-green-700 truncate">{displayName}</p>
            {product.sku || product.barcode ? (
              <p className="text-xs text-green-600 mt-0.5 truncate">
                {`Barcode: ${product.barcode || product.sku}`}
              </p>
            ) : null}
            <p className="text-sm text-green-700 mt-1 font-medium">
              PKR {displayPrice.toLocaleString()}
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
        <div
          className="mt-4 p-4 rounded-lg border border-red-200 bg-red-50 flex items-center gap-3"
        >
          <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
          <p className="text-sm text-red-700">
            Product not found for barcode "{barcodeValue}".
          </p>
        </div>
      );
    }

    if (barcodeError) {
      return (
        <div
          className="mt-4 p-4 rounded-lg border border-red-200 bg-red-50 flex items-center gap-3"
        >
          <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
          <p className="text-sm text-red-700">{barcodeError}</p>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Package className="h-6 w-6 text-indigo-600" />
          <h1 className="text-xl font-semibold text-slate-900">
            Point of Sale
          </h1>
        </div>
        <p className="text-sm text-slate-600">
          Browse products by barcode or search. Add items to cart in the next step.
        </p>
      </div>

      <div className="border border-slate-200 rounded-xl bg-slate-50 p-4">
        <div className="flex flex-col sm:flex-row gap-4 items-end sm:items-center">
          <div className="relative w-full sm:w-72">
            <Barcode
              className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
            />
            <input
              type="text"
              placeholder="Scan or enter barcode..."
              value={barcodeValue}
              onChange={(e) => setBarcodeValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleBarcodeLookup(e);
                }
              }}
              onBlur={(e) => e.target.focus()}
              className="w-full pl-9 pr-3 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition"
              autoComplete="off"
            />
          </div>
          <button
            onClick={handleBarcodeLookup}
            disabled={barcodeLoading || !barcodeValue.trim()}
            className="px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-2"
          >
            {barcodeLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Looking up...
              </>
            ) : (
              <>
                <Barcode className="h-4 w-4" /> Lookup
              </>
            )}
          </button>
        </div>
        {renderBarcodeResult()}
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
        <div className="relative flex-1 sm:w-96">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"
          />
          <input
            type="search"
            placeholder="Search products by name, SKU or barcode..."
            value={searchQuery}
            onChange={handleSearchChange}
            className="w-full pl-9 pr-3 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition"
            autoComplete="off"
          />
        </div>

        <div className="flex flex-wrap gap-2 sm:flex-nowrap">
          {PRODUCT_TYPE_FILTERS.map((filter) => (
            <button
              key={filter.value}
              onClick={handleTypeChange}
              className={`px-3 py-1.5 text-sm rounded-lg border transition ${
                productType === filter.value
                  ? 'bg-indigo-600 border-indigo-600 text-white'
                  : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        {listLoading && (
          <div className="flex flex-col items-center justify-center py-12 text-slate-500">
            <Loader2 className="h-6 w-6 animate-spin mb-2" />
            <p>Loading products...</p>
          </div>
        )}

        {listError && (
          <div className="p-6 rounded-lg border border-red-200 bg-red-50 text-center">
            <AlertCircle className="h-6 w-6 text-red-600 mx-auto mb-2" />
            <p className="text-sm text-red-700 mb-3">{listError}</p>
            <button
              onClick={handleRetry}
              className="text-sm font-medium text-indigo-600 hover:underline"
            >
              <RefreshCw className="h-4 w-4 inline mr-1" /> Retry
            </button>
          </div>
        )}

        {!listLoading && !listError && products.length === 0 && (
          <div className="py-12 text-center text-slate-500">
            <Package className="h-8 w-8 mx-auto mb-2 text-slate-300" />
            <p className="text-sm">No products found.</p>
            {searchQuery || productType ? (
              <button
                onClick={() => {
                  setSearchQuery('');
                  setProductType('');
                  requestId.current = ++requestId.current;
                  fetchProductList();
                }}
                className="mt-2 text-sm font-medium text-indigo-600 hover:underline"
              >
                Clear filters
              </button>
            ) : null}
          </div>
        )}

        {!listLoading && !listError && products.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {products.map(renderProductCard)}
          </div>
        )}
      </div>
    </div>
  );
}
