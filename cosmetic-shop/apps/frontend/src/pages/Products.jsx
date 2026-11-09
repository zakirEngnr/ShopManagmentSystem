import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus,
  Search,
  Trash2,
  Edit,
  Package,
  Image,
  Clock,
  X,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import ProductModal from '../components/ProductModal';
import { fetchProducts, adjustStock, deleteProduct } from '../api/products';
import { createCategory, fetchCategories } from '../api/categories';
import { fetchBrands } from '../api/brands';

const DEFAULT_LIMIT = 20;
const BUILT_IN_CATEGORY_NAMES = [
  { name: 'Cosmetics', type: 'COSMETIC' },
  { name: 'Jewelry', type: 'JEWELRY' },
];

const formatCurrency = (value) => {
  if (value === null || value === undefined || value === '') return 'N/A';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'N/A';
  return `Rs. ${numeric.toLocaleString('en-PK', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
};

const categoryNameFor = (categories, categoryId) => {
  if (categoryId == null) return 'Uncategorized';
  const cat = categories.find((c) => c.id === categoryId);
  return cat ? cat.name : 'Uncategorized';
};

// Helper to construct the correct image URL
const getImageUrl = (url) => {
  if (!url) return null;
  return url.startsWith('/uploads') 
    ? `${import.meta.env.VITE_API_URL || 'http://localhost:4000'}${url}` 
    : url;
};

const normalizeCategories = (items = []) => {
  const byKey = new Map();
  const merged = [];

  for (const item of items) {
    const key = String(item?.name ?? '').trim().toLowerCase();
    if (!key || byKey.has(key)) continue;
    byKey.set(key, true);
    merged.push(item);
  }

  return merged.sort((a, b) => a.name.localeCompare(b.name));
};

const ensurePermanentCategories = async (categories) => {
  const existing = new Map((categories || []).map((category) => [String(category.name).trim().toLowerCase(), category]));
  const pending = BUILT_IN_CATEGORY_NAMES.filter((cat) => !existing.has(cat.name.trim().toLowerCase()));

  if (pending.length === 0) {
    return normalizeCategories(categories);
  }

  const created = [];

  for (const category of pending) {
    try {
      const result = await createCategory(category);
      created.push(result);
    } catch (error) {
      const message = error?.response?.data?.error?.message || '';
      if (!message.toLowerCase().includes('already exists') && !message.toLowerCase().includes('unique')) {
        throw error;
      }
    }
  }

  return normalizeCategories([...(categories || []), ...created]);
};

export default function Products() {
  const [products, setProducts] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(DEFAULT_LIMIT);
  const [categories, setCategories] = useState([]);
  const [brands, setBrands] = useState([]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const [searchQuery, setSearchQuery] = useState('');
  const searchTimerRef = useRef(null);
  const requestSeqRef = useRef(0);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const [stockOpen, setStockOpen] = useState(false);
  const [stockProduct, setStockProduct] = useState(null);
  const [stockDelta, setStockDelta] = useState('');
  const [stockReason, setStockReason] = useState('PURCHASE');
  const [stockUnitCost, setStockUnitCost] = useState('');
  const [stockLoading, setStockLoading] = useState(false);
  const [stockError, setStockError] = useState(null);
  const stockReqRef = useRef(false);

  const REASONS = [
    { value: 'PURCHASE', label: 'Purchase (stock in)' },
    { value: 'DAMAGE', label: 'Damage' },
    { value: 'LOSS', label: 'Loss' },
    { value: 'RETURN', label: 'Return' },
    { value: 'CORRECTION', label: 'Correction' },
    { value: 'OTHER', label: 'Other' },
  ];

  const loadReferenceData = useCallback(async () => {
    try {
      const [baseCategories, brs] = await Promise.all([fetchCategories(), fetchBrands()]);
      const permanentCategories = await ensurePermanentCategories(baseCategories);
      setCategories(permanentCategories);
      setBrands(brs);
    } catch (err) {
      setError(err?.message || 'Could not load categories and brands.');
    }
  }, []);

  const fetchProductsPage = useCallback(
    async (search, currentPage, isRefresh = false) => {
      const requestSeq = ++requestSeqRef.current;
      if (!isRefresh) setLoading(true);
      else setRefreshing(true);
      setError(null);

      try {
        const data = await fetchProducts({ search, limit, page: currentPage });
        if (requestSeq !== requestSeqRef.current) return;
        setProducts(Array.isArray(data.products) ? data.products : []);
        setTotal(Number(data.total) || 0);
        setPage(Number(data.page) || currentPage);
      } catch (err) {
        if (requestSeq !== requestSeqRef.current) return;
        setError(err?.message || 'Failed to load products. Please try again.');
      } finally {
        if (requestSeq === requestSeqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [limit]
  );

  useEffect(() => {
    loadReferenceData();
    void fetchProductsPage('', 1);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [loadReferenceData, fetchProductsPage]);

  const handleSearchChange = (value) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      requestSeqRef.current += 1;
      void fetchProductsPage(value, 1);
    }, 300);
  };

  const clearSearch = () => {
    setSearchQuery('');
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    requestSeqRef.current += 1;
    void fetchProductsPage('', 1);
  };

  const handlePageChange = (nextPage) => {
    requestSeqRef.current += 1;
    void fetchProductsPage(searchQuery, nextPage);
  };

  const handleRefresh = () => {
    requestSeqRef.current += 1;
    void fetchProductsPage(searchQuery, page, true);
  };

  const handleSave = useCallback(() => {
    requestSeqRef.current += 1;
    void fetchProductsPage(searchQuery, page);
    setModalOpen(false);
    setEditingProduct(null);
  }, [searchQuery, page, fetchProductsPage]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteProduct(deleteTarget.id);
      setDeleteTarget(null);
      requestSeqRef.current += 1;
      void fetchProductsPage(searchQuery, page);
    } catch (err) {
      setDeleteError(
        err.response?.data?.error?.message ||
          'Failed to delete product. It may have sales history.'
      );
    } finally {
      setDeleting(false);
    }
  };

  const openStockAdjust = (product) => {
    setStockProduct(product);
    setStockDelta('');
    setStockReason('PURCHASE');
    setStockUnitCost('');
    setStockError(null);
    setStockOpen(true);
  };

  const handleStockSubmit = async (e) => {
    e.preventDefault();
    if (stockReqRef.current) return;

    const productId = stockProduct?.id;
    const delta = Number(stockDelta);

    if (!productId || !Number.isInteger(delta) || delta === 0) {
      setStockError('Enter a valid non-zero adjustment amount.');
      return;
    }
    if (stockReason === 'PURCHASE') {
      const cost = Number(stockUnitCost);
      if (!Number.isFinite(cost) || cost < 0) {
        setStockError('Unit cost is required for purchase adjustments.');
        return;
      }
    }

    stockReqRef.current = true;
    setStockLoading(true);
    setStockError(null);

    try {
      await adjustStock(
        productId,
        delta,
        stockReason,
        stockReason === 'PURCHASE' ? Number(stockUnitCost) : null
      );
      setStockOpen(false);
      requestSeqRef.current += 1;
      void fetchProductsPage(searchQuery, page);
    } catch (err) {
      setStockError(err?.message || 'Stock adjustment failed. Please try again.');
    } finally {
      setStockLoading(false);
      stockReqRef.current = false;
    }
  };

  const totalPages = Math.ceil(total / limit) || 1;
  const hasProducts = products.length > 0;
  const isEmpty = loading === false && error === null && !hasProducts;

  return (
    <div className="space-y-8 animate-fade-in max-w-7xl mx-auto rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-[0_16px_40px_rgba(15,23,42,0.08)] sm:p-7">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="p-2 rounded-xl bg-indigo-100 text-indigo-600">
              <Package className="h-5 w-5" />
            </div>
            <span className="text-xs font-bold text-indigo-600 uppercase tracking-widest">Catalog</span>
          </div>
          <h1 className="text-3xl font-extrabold text-[var(--app-text)] tracking-tight">Products</h1>
          <p className="mt-1 text-sm text-[var(--app-muted)] font-medium">
            Manage your product catalog and inventory.
          </p>
        </div>

        <button
          onClick={() => {
            setEditingProduct(null);
            setModalOpen(true);
          }}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white shadow-md shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-60 transition-colors"
        >
          <Plus className="h-4 w-4" /> Add Product
        </button>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm font-medium text-red-700 flex justify-between items-center shadow-sm">
          <span>{error}</span>
          <button
            onClick={handleRefresh}
            className="px-4 py-1.5 bg-white border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--app-muted)]" />
        <input
          type="search"
          placeholder="Search by name, SKU or barcode…"
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="w-full pl-9 pr-10 py-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-2)] text-[var(--app-text)] focus:border-indigo-500 outline-none transition-colors shadow-sm"
        />
        {searchQuery && (
          <button
            onClick={clearSearch}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[var(--app-muted)] hover:text-indigo-600"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {loading && !error ? (
        <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel-2)] p-12 text-center shadow-sm">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-500 mx-auto mb-4" />
          <p className="text-sm text-[var(--app-muted)]">Loading products…</p>
        </div>
      ) : (
        <>
          {isEmpty ? (
            <div className="rounded-3xl border-2 border-dashed border-[var(--app-border)] bg-[var(--app-panel-2)] p-12 text-center shadow-sm">
              <Package className="h-10 w-10 text-[var(--app-muted)] mx-auto mb-3" />
              <p className="text-sm text-[var(--app-muted)]">
                {searchQuery ? `No products match "${searchQuery}".` : 'No products yet.'}
              </p>
            </div>
          ) : (
            <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--app-border)] bg-[var(--app-panel-2)]">
                      <th className="px-4 py-3 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider w-16">Image</th>
                      <th className="px-4 py-3 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider">Product Name</th>
                      <th className="px-4 py-3 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider w-40">SKU</th>
                      <th className="px-4 py-3 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider w-48">Category</th>
                      <th className="px-4 py-3 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider w-32 text-right">Sell Price</th>
                      <th className="px-4 py-3 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider w-32 text-right">Stock</th>
                      <th className="px-4 py-3 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider w-40 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--app-border)]">
                    {products.map((product) => {
                      const catName = categoryNameFor(categories, product.categoryId);
                      const isLowStock =
                        product.lowStockAt != null &&
                        product.stock != null &&
                        product.stock <= product.lowStockAt;

                      return (
                        <tr
                          key={product.id}
                          className="group hover:bg-[var(--app-panel-2)] transition-colors"
                        >
                          <td className="px-4 py-4">
                            {product.imageUrl ? (
                              <img
                                src={getImageUrl(product.imageUrl)}
                                alt={product.name}
                                className="w-10 h-10 rounded-lg object-cover border border-[var(--app-border)]"
                              />
                            ) : (
                              <div className="w-10 h-10 rounded-lg border border-[var(--app-border)] flex items-center justify-center bg-[var(--app-panel-2)]">
                                <Image className="h-5 w-5 text-[var(--app-muted)]" />
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-4">
                            <p className="font-bold text-[var(--app-text)] truncate">
                              {product.name}
                            </p>
                            {product.expiryDate && (
                              <p className="text-[10px] text-[var(--app-muted)]">
                                Expires {new Date(product.expiryDate).toLocaleDateString()}
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-4 text-[var(--app-text-soft)] font-mono text-xs">
                            {product.sku}
                          </td>
                          <td className="px-4 py-4 text-[var(--app-text-soft)]">{catName}</td>
                          <td className="px-4 py-4 text-right font-bold text-[var(--app-text)]">
                            {formatCurrency(product.sellPrice)}
                          </td>
                          <td className="px-4 py-4 text-right">
                            <span
                              className={`inline-block px-2.5 py-1 rounded-md text-xs font-bold border ${
                                isLowStock
                                  ? 'bg-red-50 text-red-700 border-red-200'
                                  : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              }`}
                            >
                              {product.stock == null ? 'N/A' : product.stock}{' '}
                              {isLowStock && '· Low'}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={() => {
                                  setEditingProduct(product);
                                  setModalOpen(true);
                                }}
                                className="p-2 rounded-lg text-[var(--app-muted)] hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
                                title="Edit"
                              >
                                <Edit className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => openStockAdjust(product)}
                                className="p-2 rounded-lg text-[var(--app-muted)] hover:bg-amber-50 hover:text-amber-600 transition-colors"
                                title="Adjust Stock"
                              >
                                <Clock className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => setDeleteTarget(product)}
                                className="p-2 rounded-lg text-[var(--app-muted)] hover:bg-red-50 hover:text-red-600 transition-colors"
                                title="Delete"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {total > 0 && (
                <div className="border-t border-[var(--app-border)] px-4 py-3 flex items-center justify-between bg-[var(--app-panel-2)]">
                  <div className="text-xs text-[var(--app-muted)]">
                    Showing {products.length} of {total} products
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handlePageChange(page - 1)}
                      disabled={page === 1 || refreshing}
                      className="px-3 py-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] text-sm hover:bg-[var(--app-panel-2)] disabled:opacity-50"
                    >
                      Prev
                    </button>
                    <button
                      onClick={() => handlePageChange(page + 1)}
                      disabled={page >= totalPages || refreshing}
                      className="px-3 py-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] text-sm hover:bg-[var(--app-panel-2)] disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <ProductModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        product={editingProduct}
        onSaved={handleSave}
        categories={categories}
        brands={brands}
      />

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
            onClick={() => !deleting && setDeleteTarget(null)}
          />
          <div className="relative w-full max-w-sm bg-[var(--app-panel)] rounded-3xl shadow-2xl p-6 animate-pop-in border border-[var(--app-border)]">
            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mb-4 mx-auto">
              <AlertTriangle className="h-6 w-6 text-red-600" />
            </div>
            <h2 className="text-xl font-bold text-center text-[var(--app-text)] mb-2">
              Delete Product?
            </h2>
            <p className="text-sm text-center text-[var(--app-muted)] mb-6">
              Are you sure you want to delete <strong>{deleteTarget.name}</strong>? This action cannot be undone and will fail if the product has sales history.
            </p>
            {deleteError && (
              <div className="mb-4 p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-200">
                {deleteError}
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="flex-1 py-2.5 rounded-xl font-bold text-[var(--app-text-soft)] bg-[var(--app-panel-2)] hover:bg-[var(--app-panel)] transition-colors border border-[var(--app-border)]"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="flex-1 py-2.5 rounded-xl font-bold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-red-200"
              >
                {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {stockOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setStockOpen(false)} />
          <div className="relative w-full max-w-md bg-[var(--app-panel)] rounded-3xl shadow-2xl p-6 animate-pop-in border border-[var(--app-border)]">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-[var(--app-text)]">Adjust Stock</h2>
              <button
                onClick={() => setStockOpen(false)}
                className="p-2 rounded-xl text-[var(--app-muted)] hover:bg-[var(--app-panel-2)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-sm text-[var(--app-muted)] mb-4">
              {stockProduct?.name} · Current stock:{' '}
              <strong className="text-[var(--app-text)]">{stockProduct?.stock ?? 'N/A'}</strong>
            </p>
            {stockError && (
              <div className="p-3 mb-4 bg-red-50 text-red-600 text-sm rounded-xl border border-red-200">
                {stockError}
              </div>
            )}
            <form onSubmit={handleStockSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">
                  Adjustment Amount
                </label>
                <input
                  type="number"
                  value={stockDelta}
                  onChange={(e) => setStockDelta(e.target.value)}
                  className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none"
                  placeholder="e.g. +10 or -3"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">
                  Reason
                </label>
                <select
                  value={stockReason}
                  onChange={(e) => setStockReason(e.target.value)}
                  className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none"
                >
                  {REASONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
              {stockReason === 'PURCHASE' && (
                <div>
                  <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">
                    Unit Cost
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={stockUnitCost}
                    onChange={(e) => setStockUnitCost(e.target.value)}
                    className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none"
                    placeholder="0.00"
                  />
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setStockOpen(false)}
                  disabled={stockLoading}
                  className="px-4 py-2 rounded-xl font-bold text-[var(--app-text-soft)] bg-[var(--app-panel-2)] hover:bg-[var(--app-panel)] transition-colors border border-[var(--app-border)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={stockLoading}
                  className="px-5 py-2 rounded-xl font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 transition-colors shadow-md shadow-indigo-200"
                >
                  {stockLoading ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}