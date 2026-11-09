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

// Helper to construct the correct image URL
const getImageUrl = (url) => {
  if (!url) return null;
  return url.startsWith('/uploads') 
    ? `${import.meta.env.VITE_API_URL || 'http://localhost:4000'}${url}` 
    : url;
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
    <div className="space-y-6 max-w-7xl mx-auto animate-fade-in">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-indigo-100 dark:bg-indigo-500/20 rounded-xl">
            <Package className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Products</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Manage your product catalog and inventory.
            </p>
          </div>
        </div>
        <button
          onClick={() => {
            setEditingProduct(null);
            setModalOpen(true);
          }}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white shadow-md shadow-indigo-200 dark:shadow-indigo-900/30 hover:bg-indigo-700 disabled:opacity-60 transition-colors"
        >
          <Plus className="h-4 w-4" /> Add Product
        </button>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 px-5 py-4 text-sm font-medium text-red-700 dark:text-red-400 flex justify-between items-center">
          <span>{error}</span>
          <button
            onClick={handleRefresh}
            className="px-4 py-1.5 bg-white dark:bg-slate-900 border border-red-200 dark:border-red-500/20 rounded-lg hover:bg-red-100 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
        <input
          type="search"
          placeholder="Search by name, SKU or barcode…"
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="w-full pl-9 pr-10 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:border-indigo-500 outline-none transition-colors"
        />
        {searchQuery && (
          <button
            onClick={clearSearch}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-indigo-600"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {loading && !error ? (
        <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-12 text-center shadow-sm">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-500 mx-auto mb-4" />
          <p className="text-sm text-slate-500 dark:text-slate-400">Loading products…</p>
        </div>
      ) : (
        <>
          {isEmpty ? (
            <div className="rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/20 p-12 text-center">
              <Package className="h-10 w-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {searchQuery ? `No products match "${searchQuery}".` : 'No products yet.'}
              </p>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
                      <th className="px-4 py-3 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider w-16">Image</th>
                      <th className="px-4 py-3 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Product Name</th>
                      <th className="px-4 py-3 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider w-40">SKU</th>
                      <th className="px-4 py-3 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider w-48">Category</th>
                      <th className="px-4 py-3 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider w-32 text-right">Sell Price</th>
                      <th className="px-4 py-3 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider w-32 text-right">Stock</th>
                      <th className="px-4 py-3 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider w-40 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {products.map((product) => {
                      const catName = categoryNameFor(categories, product.categoryId);
                      const isLowStock =
                        product.lowStockAt != null &&
                        product.stock != null &&
                        product.stock <= product.lowStockAt;

                      return (
                        <tr
                          key={product.id}
                          className="group hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                        >
                          <td className="px-4 py-4">
                            {product.imageUrl ? (
                              <img
                                src={getImageUrl(product.imageUrl)}
                                alt={product.name}
                                className="w-10 h-10 rounded-lg object-cover border border-slate-200 dark:border-slate-700"
                              />
                            ) : (
                              <div className="w-10 h-10 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center bg-slate-50 dark:bg-slate-800">
                                <Image className="h-5 w-5 text-slate-400" />
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-4">
                            <p className="font-bold text-slate-900 dark:text-white truncate">
                              {product.name}
                            </p>
                            {product.expiryDate && (
                              <p className="text-[10px] text-slate-500 dark:text-slate-400">
                                Expires {new Date(product.expiryDate).toLocaleDateString()}
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-4 text-slate-600 dark:text-slate-400 font-mono text-xs">
                            {product.sku}
                          </td>
                          <td className="px-4 py-4 text-slate-600 dark:text-slate-400">{catName}</td>
                          <td className="px-4 py-4 text-right font-bold text-slate-900 dark:text-white">
                            {formatCurrency(product.sellPrice)}
                          </td>
                          <td className="px-4 py-4 text-right">
                            <span
                              className={`inline-block px-2.5 py-1 rounded-md text-xs font-bold border ${
                                isLowStock
                                  ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/20 dark:text-red-300 dark:border-red-500/20'
                                  : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/20 dark:text-emerald-300 dark:border-emerald-500/20'
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
                                className="p-2 rounded-lg text-slate-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/20 hover:text-indigo-600 transition-colors"
                                title="Edit"
                              >
                                <Edit className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => openStockAdjust(product)}
                                className="p-2 rounded-lg text-slate-400 hover:bg-amber-50 dark:hover:bg-amber-500/20 hover:text-amber-600 transition-colors"
                                title="Adjust Stock"
                              >
                                <Clock className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => setDeleteTarget(product)}
                                className="p-2 rounded-lg text-slate-400 hover:bg-red-50 dark:hover:bg-red-500/20 hover:text-red-600 transition-colors"
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
                <div className="border-t border-slate-200 dark:border-slate-800 px-4 py-3 flex items-center justify-between bg-slate-50 dark:bg-slate-800/50">
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Showing {products.length} of {total} products
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handlePageChange(page - 1)}
                      disabled={page === 1 || refreshing}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                    >
                      Prev
                    </button>
                    <button
                      onClick={() => handlePageChange(page + 1)}
                      disabled={page >= totalPages || refreshing}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
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
          <div className="relative w-full max-w-sm bg-white dark:bg-slate-900 rounded-3xl shadow-2xl p-6 animate-pop-in border border-slate-200 dark:border-slate-800">
            <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-500/20 flex items-center justify-center mb-4 mx-auto">
              <AlertTriangle className="h-6 w-6 text-red-600 dark:text-red-400" />
            </div>
            <h2 className="text-xl font-bold text-center text-slate-900 dark:text-white mb-2">
              Delete Product?
            </h2>
            <p className="text-sm text-center text-slate-500 dark:text-slate-400 mb-6">
              Are you sure you want to delete <strong>{deleteTarget.name}</strong>? This action cannot be undone and will fail if the product has sales history.
            </p>
            {deleteError && (
              <div className="mb-4 p-3 bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 text-sm rounded-xl border border-red-200 dark:border-red-500/20">
                {deleteError}
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="flex-1 py-2.5 rounded-xl font-bold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="flex-1 py-2.5 rounded-xl font-bold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-red-200 dark:shadow-red-900/30"
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
          <div className="relative w-full max-w-md bg-white dark:bg-slate-900 rounded-3xl shadow-2xl p-6 animate-pop-in border border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">Adjust Stock</h2>
              <button
                onClick={() => setStockOpen(false)}
                className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
              {stockProduct?.name} · Current stock:{' '}
              <strong className="text-slate-900 dark:text-white">{stockProduct?.stock ?? 'N/A'}</strong>
            </p>
            {stockError && (
              <div className="p-3 mb-4 bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 text-sm rounded-xl border border-red-200 dark:border-red-500/20">
                {stockError}
              </div>
            )}
            <form onSubmit={handleStockSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Adjustment Amount
                </label>
                <input
                  type="number"
                  value={stockDelta}
                  onChange={(e) => setStockDelta(e.target.value)}
                  className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white outline-none"
                  placeholder="e.g. +10 or -3"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Reason
                </label>
                <select
                  value={stockReason}
                  onChange={(e) => setStockReason(e.target.value)}
                  className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white outline-none"
                >
                  {REASONS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
              {stockReason === 'PURCHASE' && (
                <div>
                  <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Unit Cost
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={stockUnitCost}
                    onChange={(e) => setStockUnitCost(e.target.value)}
                    className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-slate-900 dark:text-white outline-none"
                    placeholder="0.00"
                  />
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setStockOpen(false)}
                  disabled={stockLoading}
                  className="px-4 py-2 rounded-xl font-bold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={stockLoading}
                  className="px-5 py-2 rounded-xl font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 transition-colors shadow-md shadow-indigo-200 dark:shadow-indigo-900/30"
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