import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus,
  Search,
  RefreshCw,
  Trash2,
  Edit,
  Package,
  Image,
  Clock,
  X,
} from 'lucide-react';
import ProductModal from '../components/ProductModal';
import {
  fetchProducts,
  adjustStock,
  deleteProduct,
} from '../api/products';
import { fetchCategories } from '../api/categories';
import { fetchBrands } from '../api/brands';

const DEFAULT_LIMIT = 20;

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
      const [cats, brs] = await Promise.all([fetchCategories(), fetchBrands()]);
      setCategories(cats);
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

  const handleCreate = () => {
    setEditingProduct(null);
    setModalOpen(true);
  };

  const handleEdit = (product) => {
    setEditingProduct(product);
    setModalOpen(true);
  };

  const handleDelete = (id) => {
    if (!window.confirm('Delete this product? This cannot be undone if it has sales or stock history.')) return;
    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    deleteProduct(id)
      .then(() => {
        if (requestSeq !== requestSeqRef.current) return;
        void fetchProductsPage(searchQuery, page);
      })
      .catch((err) => {
        if (requestSeq !== requestSeqRef.current) return;
        setError(err?.message || 'Failed to delete product.');
        setLoading(false);
      });
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
      if (!stockReqRef.current) return;
      setStockOpen(false);
      requestSeqRef.current += 1;
      void fetchProductsPage(searchQuery, page);
    } catch (err) {
      if (!stockReqRef.current) return;
      setStockError(err?.message || 'Stock adjustment failed. Please try again.');
    } finally {
      if (stockReqRef.current) {
        setStockLoading(false);
        stockReqRef.current = false;
      }
    }
  };

  const totalPages = Math.ceil(total / limit) || 1;
  const hasProducts = products.length > 0;
  const isEmpty = loading === false && error === null && !hasProducts;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Package className="h-6 w-6 text-indigo-600" />
          <div>
            <h1 className="text-2xl font-bold text-[var(--app-text)]">Products</h1>
            <p className="text-sm text-[var(--app-text-soft)]">
              Manage your product catalog and inventory stock levels.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-4 sm:pt-0">
          <button
            onClick={handleCreate}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white shadow-md shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            <Plus className="h-4 w-4" />
            Add Product
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm font-medium text-red-700 flex justify-between items-center shadow-sm">
          <span>{error}</span>
          <button
            onClick={handleRefresh}
            className="px-4 py-1.5 bg-white border border-red-200 rounded-lg hover:bg-red-100 transition-colors text-sm font-medium text-red-700"
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
          className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-text)] focus:border-indigo-500 focus:outline-none transition-colors"
        />
        {searchQuery && (
          <button
            onClick={clearSearch}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[var(--app-muted)] hover:text-indigo-600 transition-colors"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {loading && !error ? (
        <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] p-12 text-center">
          <div className="animate-pulse h-8 w-32 bg-[var(--app-border)]/50 rounded mx-auto mb-4" />
          <p className="text-sm text-[var(--app-text-soft)]">Loading products…</p>
        </div>
      ) : (
        <>
          {isEmpty && searchQuery ? (
            <div className="rounded-3xl border-2 border-dashed border-[var(--app-border)] bg-[var(--app-bg)]/50 p-12 text-center">
              <Search className="h-10 w-10 text-[var(--app-muted)] mx-auto mb-3" />
              <p className="text-sm text-[var(--app-text-soft)]">
                No products match "{searchQuery}".
              </p>
              <button
                onClick={clearSearch}
                className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-indigo-600 hover:underline"
              >
                Clear search <X className="h-4 w-4" />
              </button>
            </div>
          ) : isEmpty && !searchQuery ? (
            <div className="rounded-3xl border-2 border-dashed border-[var(--app-border)] bg-[var(--app-bg)]/50 p-12 text-center">
              <Package className="h-10 w-10 text-[var(--app-muted)] mx-auto mb-3" />
              <p className="text-sm text-[var(--app-text-soft)]">No products yet.</p>
              <button
                onClick={handleCreate}
                className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-indigo-600 hover:underline"
              >
                Add your first product <Plus className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--app-border)] bg-[var(--app-panel-2)]">
                      <th className="px-4 py-3 text-xs font-semibold text-[var(--app-text-soft)] w-16">Image</th>
                      <th className="px-4 py-3 text-xs font-semibold text-[var(--app-text-soft)]">Product Name</th>
                      <th className="px-4 py-3 text-xs font-semibold text-[var(--app-text-soft)] w-40">SKU</th>
                      <th className="px-4 py-3 text-xs font-semibold text-[var(--app-text-soft)] w-48">Category</th>
                      <th className="px-4 py-3 text-xs font-semibold text-[var(--app-text-soft)] w-32 text-right">Sell Price</th>
                      <th className="px-4 py-3 text-xs font-semibold text-[var(--app-text-soft)] w-32 text-right">Stock</th>
                      <th className="px-4 py-3 text-xs font-semibold text-[var(--app-text-soft)] w-40 text-right">Actions</th>
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
                        <tr key={product.id} className="group hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-colors">
                          <td className="px-4 py-4">
                            <div className="flex items-center gap-3">
                              {product.imageUrl ? (
                                <img
                                  src={product.imageUrl}
                                  alt={product.name}
                                  className="w-10 h-10 rounded-lg object-cover border border-[var(--app-border)]"
                                />
                              ) : (
                                <div className="w-10 h-10 rounded-lg border border-[var(--app-border)] flex items-center justify-center bg-[var(--app-bg)]/50">
                                  <Image className="h-5 w-5 text-[var(--app-muted)]" />
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <p className="font-medium text-[var(--app-text)] truncate">{product.name}</p>
                            {product.expiryDate && (
                              <p className="text-[10px] text-[var(--app-muted)] font-medium">
                                Expires {new Date(product.expiryDate).toLocaleDateString()}
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-4 text-[var(--app-text-soft)] font-mono truncate">{product.sku}</td>
                          <td className="px-4 py-4 text-[var(--app-text-soft)] truncate">{catName}</td>
                          <td className="px-4 py-4 text-right font-medium text-[var(--app-text)]">{formatCurrency(product.sellPrice)}</td>
                          <td className="px-4 py-4 text-right">
                            <span
                              className={`inline-block px-2.5 py-1 rounded text-xs font-bold border text-center min-w-[42px] ${
                                isLowStock
                                  ? 'bg-red-50 text-red-700 border-red-200'
                                  : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              }`}
                            >
                              {product.stock == null ? 'N/A' : product.stock}
                              {isLowStock ? ' · low' : ''}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => handleEdit(product)}
                                disabled={loading}
                                className="p-2 rounded-md text-[var(--app-text-soft)] hover:bg-indigo-50 hover:text-indigo-600 transition-colors disabled:opacity-60"
                                aria-label={`Edit ${product.name}`}
                              >
                                <Edit className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => openStockAdjust(product)}
                                disabled={loading}
                                className="p-2 rounded-md text-[var(--app-text-soft)] hover:bg-amber-50 hover:text-amber-600 transition-colors disabled:opacity-60"
                                aria-label={`Adjust stock for ${product.name}`}
                              >
                                <Clock className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDelete(product.id)}
                                disabled={loading}
                                className="p-2 rounded-md text-[var(--app-text-soft)] hover:bg-red-50 hover:text-red-600 transition-colors disabled:opacity-60"
                                aria-label={`Delete ${product.name}`}
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
                  <div className="text-xs text-[var(--app-text-soft)]">
                    Showing {products.length} of {total} products
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => page > 1 && handlePageChange(page - 1)}
                      disabled={page === 1 || refreshing}
                      className="px-3 py-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-text)] text-sm hover:bg-[var(--app-border)] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                    >
                      Prev
                    </button>
                    <button
                      onClick={() => page < totalPages && handlePageChange(page + 1)}
                      disabled={page >= totalPages || refreshing}
                      className="px-3 py-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-text)] text-sm hover:bg-[var(--app-border)] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                    >
                      Next
                    </button>
                    <span className="px-2 py-1.5 text-xs text-[var(--app-muted)]">
                      {page} / {totalPages}
                    </span>
                    {refreshing && (
                      <RefreshCw className="h-3 w-3 animate-spin text-indigo-600" />
                    )}
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

      <div className={`fixed inset-0 z-50 ${stockOpen ? 'flex items-center justify-center' : 'hidden'}`}>
        {stockOpen && (
          <>
            <div
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setStockOpen(false)}
            />
            <div className="relative w-full max-w-md mx-4 rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-2xl p-6 flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-[var(--app-text)]">Adjust Stock</h2>
                <button
                  type="button"
                  onClick={() => setStockOpen(false)}
                  aria-label="Close"
                  className="rounded-xl p-2 text-[var(--app-text-soft)] hover:bg-[var(--app-border)] transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <p className="text-sm text-[var(--app-text-soft)] mb-4">
                {stockProduct?.name} · Current stock: <span className="font-medium text-[var(--app-text)]">{stockProduct?.stock ?? 'N/A'}</span>
              </p>

              {stockError && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 mb-4">
                  {stockError}
                </div>
              )}

              <form onSubmit={handleStockSubmit} className="space-y-4">
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-[var(--app-text-soft)]">Adjustment Amount</label>
                  <input
                    type="number"
                    value={stockDelta}
                    onChange={(e) => setStockDelta(e.target.value)}
                    className="block w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2.5 text-sm text-[var(--app-text)] focus:border-indigo-500 focus:outline-none"
                    placeholder="e.g. +10 or -3"
                  />
                  <p className="text-xs text-[var(--app-muted)]">
                    Positive increases stock; negative decreases it.
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-[var(--app-text-soft)]">Reason</label>
                  <select
                    value={stockReason}
                    onChange={(e) => setStockReason(e.target.value)}
                    className="block w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2.5 text-sm text-[var(--app-text)] focus:border-indigo-500 focus:outline-none"
                  >
                    {REASONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>

                {stockReason === 'PURCHASE' && (
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-[var(--app-text-soft)]">Unit Cost (required for purchase)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={stockUnitCost}
                      onChange={(e) => setStockUnitCost(e.target.value)}
                      className="block w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2.5 text-sm text-[var(--app-text)] focus:border-indigo-500 focus:outline-none"
                      placeholder="0.00"
                    />
                  </div>
                )}

                <div className="flex justify-end gap-3 pt-4 border-t border-[var(--app-border)]">
                  <button
                    type="button"
                    onClick={() => setStockOpen(false)}
                    disabled={stockLoading}
                    className="px-5 py-2.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-text)] font-medium hover:bg-[var(--app-border)] disabled:opacity-60 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={stockLoading}
                    className="px-6 py-2.5 rounded-xl bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-md shadow-indigo-200"
                  >
                    {stockLoading ? 'Adjusting…' : 'Adjust Stock'}
                  </button>
                </div>
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
