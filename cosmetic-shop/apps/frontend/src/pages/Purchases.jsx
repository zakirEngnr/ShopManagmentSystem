import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  Loader2,
  Minus,
  Plus,
  ReceiptText,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  Truck,
  Wallet,
  X,
} from 'lucide-react';
import { fetchProducts } from '../api/products';
import { fetchPurchases, fetchPurchase, createPurchase, buildPurchasePayload } from '../api/purchases';
import { fetchSuppliers } from '../api/suppliers';
import { fetchCategories } from '../api/categories';
import { fetchBrands } from '../api/brands';
import { useMoneyOperation } from '../hooks/useMoneyOperation.js';
import { useUnresolvedOperations } from '../hooks/useUnresolvedOperations.js';
import { MONEY_OUTCOME } from '../utils/moneyOperation.js';
import UnresolvedOperationNotice from '../components/UnresolvedOperationNotice.jsx';
import UnresolvedOperationsBanner from '../components/UnresolvedOperationsBanner.jsx';
import PurchaseDetailModal from '../components/PurchaseDetailModal.jsx';

/**
 * Scope of the purchase operation. The Purchases page has one active form,
 * so a single scope is used: an unresolved purchase blocks every later one.
 */
const PURCHASE_SCOPE = 'purchase';

const formatCurrency = (value) => {
  if (value === null || value === undefined || value === '') return 'Rs. 0';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'Rs. 0';
  return `Rs. ${numeric.toLocaleString('en-PK', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
};

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
};

const getEmptyNewProduct = () => ({
  sku: '',
  barcode: '',
  name: '',
  type: 'COSMETIC',
  costPrice: '',
  sellPrice: '',
  categoryId: '',
  brandId: '',
  lowStockAt: '',
  expiryDate: '',
});

const getEmptyItem = () => ({
  type: 'existing',
  productId: '',
  quantity: '1',
  unitCost: '0',
  newProduct: getEmptyNewProduct(),
});

const getDuplicateExistingProductError = (item, index, items = []) => {
  if (item.type !== 'existing') return '';

  const selectedProductId = Number(item.productId);
  if (!Number.isFinite(selectedProductId) || selectedProductId <= 0) {
    return '';
  }

  const isDuplicate = items.some((entry, itemIndex) => {
    if (itemIndex === index) return false;
    if (entry.type !== 'existing') return false;
    return Number(entry.productId) === selectedProductId;
  });

  return isDuplicate ? 'This product is already added to this purchase.' : '';
};

export default function Purchases() {
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [brands, setBrands] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [limit] = useState(10);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [selectedSupplierId, setSelectedSupplierId] = useState('');
  const searchTimerRef = useRef(null);
  const purchaseRequestSeqRef = useRef(0);
  const [formError, setFormError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  const [purchaseModalOpen, setPurchaseModalOpen] = useState(false);
  const [purchaseForm, setPurchaseForm] = useState({ supplierId: '', items: [getEmptyItem()] });
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  // Purchase detail view state.
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [detailPurchase, setDetailPurchase] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);

  // The idempotency key AND the payload of the purchase that is being
  // entered. A retry reuses both, so the stock is not incremented twice.
  const purchaseOperation = useMoneyOperation({
    scope: PURCHASE_SCOPE,
    operation: 'POST /purchases',
    label: 'purchase',
    send: createPurchase,
  });
  const purchaseLocked = purchaseOperation.locked;

  // The same warning at the page level: an unresolved purchase must stay
  // visible even when the purchase dialog is closed.
  const unresolvedPurchases = useUnresolvedOperations({
    workflow: PURCHASE_SCOPE,
    operation: 'POST /purchases',
    label: 'purchase',
    send: createPurchase,
  });

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / limit)), [total, limit]);

  const loadReferenceData = async () => {
    const [suppliersResponse, productsResponse, categoriesResponse, brandsResponse] = await Promise.all([
      fetchSuppliers({ page: 1, limit: 100 }),
      fetchProducts({ page: 1, limit: 100 }),
      fetchCategories(),
      fetchBrands(),
    ]);

    setSuppliers(suppliersResponse.suppliers);
    setProducts(productsResponse.products || []);
    setCategories(categoriesResponse || []);
    setBrands(brandsResponse || []);
  };

  const loadPurchases = async () => {
    const currentRequestSeq = ++purchaseRequestSeqRef.current;
    setLoading(true);
    try {
      const response = await fetchPurchases({
        page,
        limit,
        supplierId: selectedSupplierId || undefined,
        search,
      });
      // Ignore stale responses from older search/page requests.
      if (currentRequestSeq !== purchaseRequestSeqRef.current) return;
      setPurchases(response.purchases || []);
      setTotal(response.total || 0);
    } catch (error) {
      if (currentRequestSeq !== purchaseRequestSeqRef.current) return;
      setFormError(error?.response?.data?.error?.message || error?.message || 'Failed to load purchases.');
      setPurchases([]);
    } finally {
      if (currentRequestSeq === purchaseRequestSeqRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadReferenceData();
  }, []);

  useEffect(() => {
    // Cancel any pending timeout from a previous render.
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }

    // Schedule the search‑triggered request after the 300 ms debounce.
    searchTimerRef.current = setTimeout(() => {
      void loadPurchases();
    }, 300);
    // Clean up the timeout on unmount or when deps change.
    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }
    };
  }, [search, page, selectedSupplierId]);

  const itemsSummary = useMemo(() => {
    const safeItems = purchaseForm.items || [];
    let grandTotal = 0;

    safeItems.forEach((item) => {
      const quantity = Number(item.quantity) || 0;
      const unitCost = Number(item.unitCost) || 0;
      grandTotal += quantity * unitCost;
    });

    return grandTotal;
  }, [purchaseForm.items]);

  const updateItem = (index, field, value) => {
    // While a purchase is unresolved its payload is frozen: changing it could
    // record a second purchase and increment the stock twice.
    if (purchaseLocked) return;
    setPurchaseForm((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) => (itemIndex === index ? { ...item, [field]: value } : item)),
    }));
  };

  const addPurchaseItem = () => {
    if (purchaseLocked) return;
    setPurchaseForm((current) => ({
      ...current,
      items: [...current.items, getEmptyItem()],
    }));
  };

  const removePurchaseItem = (index) => {
    if (purchaseLocked) return;
    setPurchaseForm((current) => ({
      ...current,
      items: current.items.length === 1 ? [getEmptyItem()] : current.items.filter((_, itemIndex) => itemIndex !== index),
    }));
  };

  /**
   * Apply the result of a submission to the screen.
   *
   * @param {object} outcome - The result of `purchaseOperation.submit()` or
   *   `purchaseOperation.retry()`.
   */
  const applyOutcome = async (outcome) => {
    if (outcome.outcome === MONEY_OUTCOME.SENT) {
      // The server confirmed the purchase: the UI is built from the values
      // the server returned.
      const purchase = outcome.result || {};
      setSuccessMessage(
        `Purchase #${purchase.id ?? '-'} created successfully (${formatCurrency(purchase.totalAmount)}).`,
      );
      setPurchaseForm({ supplierId: '', items: [getEmptyItem()] });
      setPurchaseModalOpen(false);
      setSubmitError(null);
      await loadPurchases();
      await loadReferenceData();
      return;
    }

    // A blocked submission, an ambiguous outcome, a verified failure, a
    // request that could not be sent safely and a request that is already in
    // flight all end up here.
    setSubmitError(outcome.message);
  };

  const handleCreatePurchase = async (event) => {
    event.preventDefault();

    const supplierId = Number(purchaseForm.supplierId);
    if (!supplierId) {
      setSubmitError('Select a supplier.');
      return;
    }

    const normalizedItems = [];

    for (let index = 0; index < purchaseForm.items.length; index += 1) {
      const item = purchaseForm.items[index];
      const duplicateError = getDuplicateExistingProductError(item, index, purchaseForm.items);
      if (duplicateError) {
        setSubmitError(`${duplicateError} Please choose a different product.`);
        return;
      }

      const quantity = Number(item.quantity);
      const unitCost = Number(item.unitCost);

      if (!Number.isFinite(quantity) || quantity <= 0) {
        setSubmitError('Each quantity must be a positive number.');
        return;
      }
      if (!Number.isFinite(unitCost) || unitCost < 0) {
        setSubmitError('Each unit cost must be a valid non-negative number.');
        return;
      }

      if (item.type === 'new') {
        const newProduct = item.newProduct || getEmptyNewProduct();
        const cleanedProduct = {
          sku: String(newProduct.sku ?? '').trim(),
          barcode: newProduct.barcode ? String(newProduct.barcode).trim() : null,
          name: String(newProduct.name ?? '').trim(),
          type: String(newProduct.type || 'COSMETIC'),
          costPrice: Number(newProduct.costPrice),
          sellPrice: Number(newProduct.sellPrice),
          categoryId: Number(newProduct.categoryId),
          brandId: newProduct.brandId ? Number(newProduct.brandId) : null,
        };

        if (!cleanedProduct.name || !cleanedProduct.sku || !Number.isFinite(cleanedProduct.costPrice) || !Number.isFinite(cleanedProduct.sellPrice) || !cleanedProduct.categoryId) {
          setSubmitError('Complete the new product details before saving the purchase.');
          return;
        }

        normalizedItems.push({
          newProduct: cleanedProduct,
          quantity,
          unitCost,
        });
        continue;
      }

      const productId = Number(item.productId);
      if (!productId) {
        setSubmitError('Select a product for each row.');
        return;
      }

      normalizedItems.push({
        productId,
        quantity,
        unitCost,
      });
    }

    if (!normalizedItems.length) {
      setSubmitError('Add at least one product to the purchase.');
      return;
    }

    // The EXACT body that is sent. It is stored with the key, so a replay
    // sends the very same body and not one rebuilt from the form.
    const payload = buildPurchasePayload({ supplierId, items: normalizedItems });

    setSaving(true);
    setSubmitError(null);

    try {
      // While a purchase is unresolved, a DIFFERENT body is refused instead
      // of sent.
      const outcome = await purchaseOperation.submit(payload);
      await applyOutcome(outcome);
    } finally {
      setSaving(false);
    }
  };

  /** Send the ORIGINAL purchase again, unchanged. */
  const handleRetryPurchase = async () => {
    if (saving) return;
    setSaving(true);
    setSubmitError(null);

    try {
      const outcome = await purchaseOperation.retry();
      await applyOutcome(outcome);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Explicitly start something else. The original request may already have
   * been committed - this does not undo it.
   */
  const handleAbandonPurchase = () => {
    purchaseOperation.abandon();
    setPurchaseForm({ supplierId: '', items: [getEmptyItem()] });
    setSubmitError(null);
  };

  /**
   * Open the detail view of a purchase.
   *
   * @param {number|string} id - The purchase id.
   */
  const handleViewPurchase = async (id) => {
    setDetailLoading(true);
    setDetailError(null);
    setDetailPurchase(null);

    try {
      const purchase = await fetchPurchase(id);
      setDetailPurchase(purchase);
      setDetailModalOpen(true);
    } catch (error) {
      setDetailError(
        error?.response?.data?.message ||
        error?.message ||
        'Unable to load the purchase details.',
      );
      setDetailModalOpen(true);
    } finally {
      setDetailLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-[var(--app-muted)]">Purchases</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-[var(--app-text)]">Purchase Register</h1>
        </div>
        <button
          type="button"
          onClick={() => setPurchaseModalOpen(true)}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500"
        >
          <Plus className="h-4 w-4" />
          Add purchase
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-sm">
          <div className="flex items-center justify-between text-[var(--app-muted)]">
            <span className="text-sm font-medium">Purchases</span>
            <ReceiptText className="h-4 w-4" />
          </div>
          <p className="mt-4 text-3xl font-bold text-[var(--app-text)]">{total}</p>
        </div>

        <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-sm">
          <div className="flex items-center justify-between text-[var(--app-muted)]">
            <span className="text-sm font-medium">Supplier filter</span>
            <Truck className="h-4 w-4" />
          </div>
          <select
            value={selectedSupplierId}
            onChange={(event) => setSelectedSupplierId(event.target.value)}
            className="mt-4 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3 py-2 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
          >
            <option value="">All suppliers</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
            ))}
          </select>
        </div>

        <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-sm">
          <div className="flex items-center justify-between text-[var(--app-muted)]">
            <span className="text-sm font-medium">Total stock impact</span>
            <Wallet className="h-4 w-4" />
          </div>
          <p className="mt-4 text-lg font-semibold text-[var(--app-text)]">Inventory increases on purchase</p>
        </div>
      </div>

      {successMessage && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-900/20 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4" />
          {successMessage}
        </div>
      )}

      <UnresolvedOperationsBanner
        label="purchase"
        records={unresolvedPurchases.records}
        busy={unresolvedPurchases.busy}
        onRetry={unresolvedPurchases.retry}
        onAbandon={unresolvedPurchases.abandon}
        onOpen={() => setPurchaseModalOpen(true)}
      />

      {formError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-300">
          <AlertCircle className="h-4 w-4" />
          {formError}
        </div>
      )}

      <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4 shadow-sm">
        <label className="relative block">
          <span className="sr-only">Search purchase records</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--app-muted)]" />
          <input
            value={search}
            onChange={(event) => {
              const value = event.target.value;
              setSearch(value);
              setPage(1);
            }}
            placeholder="Search by supplier name"
            className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] py-2.5 pl-10 pr-4 text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500"
          />
        </label>
      </div>

      {loading ? (
        <div className="flex min-h-[220px] items-center justify-center rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)]">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--app-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading purchases...
          </div>
        </div>
      ) : purchases.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] p-10 text-center text-[var(--app-muted)]">
          No purchases match the current search.
        </div>
      ) : (
        <div className="space-y-4">
          {purchases.map((purchase) => {
            const totalAmount = Number(purchase.totalAmount || 0);
            const paidAmount = Number(purchase.paidAmount || 0);
            const outstanding = totalAmount - paidAmount;
            const status = purchase.status || 'UNPAID';
            const badgeClass =
              status === 'PAID'
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                : status === 'PARTIAL'
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                  : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300';

            return (
              <div key={purchase.id} className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-sm">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="flex items-center gap-3">
                      <h2 className="text-lg font-semibold text-[var(--app-text)]">#{purchase.id}</h2>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${badgeClass}`}>{status}</span>
                    </div>
                    <p className="mt-2 text-sm text-[var(--app-text-soft)]">
                      Supplier: {purchase.supplier?.name || 'Unknown'}
                    </p>
                    <div className="mt-2 flex items-center gap-2 text-sm text-[var(--app-text-soft)]">
                      <CalendarDays className="h-4 w-4 text-[var(--app-muted)]" />
                      {formatDate(purchase.createdAt)}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleViewPurchase(purchase.id)}
                      data-testid="purchase-detail-view"
                      className="mt-3 inline-flex items-center gap-2 rounded-lg border border-[var(--app-border)] px-3 py-2 text-xs font-bold text-[var(--app-text)] transition hover:bg-[var(--app-panel-2)]"
                    >
                      <ReceiptText className="h-3.5 w-3.5" /> View details
                    </button>
                  </div>

                  <div className="grid gap-3 text-sm md:grid-cols-3">
                    <div>
                      <p className="text-[var(--app-muted)]">Total</p>
                      <p className="font-semibold text-[var(--app-text)]">{formatCurrency(totalAmount)}</p>
                    </div>
                    <div>
                      <p className="text-[var(--app-muted)]">Paid</p>
                      <p className="font-semibold text-[var(--app-text)]">{formatCurrency(paidAmount)}</p>
                    </div>
                    <div>
                      <p className="text-[var(--app-muted)]">Outstanding</p>
                      <p className="font-semibold text-[var(--app-text)]">{formatCurrency(Math.max(0, outstanding))}</p>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-4 shadow-sm">
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page <= 1}
            className="rounded-xl border border-[var(--app-border)] px-3 py-2 text-sm font-medium text-[var(--app-text-soft)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-sm text-[var(--app-text-soft)]">Page {page} of {totalPages}</span>
          <button
            type="button"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={page >= totalPages}
            className="rounded-xl border border-[var(--app-border)] px-3 py-2 text-sm font-medium text-[var(--app-text-soft)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}

      {purchaseModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-xl">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-xl font-semibold text-[var(--app-text)]">Create purchase</h2>
              <button
                type="button"
                onClick={() => setPurchaseModalOpen(false)}
                disabled={purchaseLocked}
                title={purchaseLocked ? 'An unresolved purchase keeps its own details until it is retried or abandoned.' : undefined}
                className="rounded-lg p-2 text-[var(--app-muted)] hover:bg-[var(--app-panel-2)] disabled:opacity-50"
              >×</button>
            </div>

            <form onSubmit={handleCreatePurchase} className="space-y-5">
              <UnresolvedOperationNotice
                label="purchase"
                unresolved={purchaseOperation.unresolved}
                busy={saving}
                onRetry={handleRetryPurchase}
                onAbandon={handleAbandonPurchase}
              />

              <fieldset disabled={purchaseLocked} className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-[var(--app-text-soft)]">Supplier</label>
                  <select
                    value={purchaseForm.supplierId}
                    onChange={(event) => setPurchaseForm((current) => ({ ...current, supplierId: event.target.value }))}
                    className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                  >
                    <option value="">Select supplier</option>
                    {suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                    ))}
                  </select>
                </div>

                <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--app-muted)]">Grand total</p>
                  <p className="mt-2 text-2xl font-bold text-[var(--app-text)]">{formatCurrency(itemsSummary)}</p>
                </div>
              </div>

              <div className="space-y-3">
                {purchaseForm.items.map((item, index) => {
                  const duplicateError = getDuplicateExistingProductError(item, index, purchaseForm.items);

                  return (
                    <div key={index} className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-2)] p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <span className="text-sm font-medium text-[var(--app-text-soft)]">Item {index + 1}</span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => updateItem(index, 'type', 'existing')}
                            className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${item.type === 'existing' ? 'bg-indigo-600 text-white' : 'border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text-soft)]'}`}
                          >
                            Existing
                          </button>
                          <button
                            type="button"
                            onClick={() => updateItem(index, 'type', 'new')}
                            className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${item.type === 'new' ? 'bg-indigo-600 text-white' : 'border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text-soft)]'}`}
                          >
                            New product
                          </button>
                          {purchaseForm.items.length > 1 && (
                            <button type="button" onClick={() => removePurchaseItem(index)} className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-300">
                              <Trash2 className="h-3.5 w-3.5" /> Remove
                            </button>
                          )}
                        </div>
                      </div>

                      {item.type === 'new' ? (
                        <div className="space-y-3">
                          <div className="grid gap-3 md:grid-cols-2">
                            <div>
                              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-[var(--app-muted)]">SKU</label>
                              <input
                                value={item.newProduct?.sku || ''}
                                onChange={(event) => updateItem(index, 'newProduct', { ...item.newProduct, sku: event.target.value })}
                                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                              />
                            </div>
                            <div>
                              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-[var(--app-muted)]">Barcode</label>
                              <input
                                value={item.newProduct?.barcode || ''}
                                onChange={(event) => updateItem(index, 'newProduct', { ...item.newProduct, barcode: event.target.value })}
                                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                              />
                            </div>
                            <div className="md:col-span-2">
                              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-[var(--app-muted)]">Product name</label>
                              <input
                                value={item.newProduct?.name || ''}
                                onChange={(event) => updateItem(index, 'newProduct', { ...item.newProduct, name: event.target.value })}
                                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                              />
                            </div>
                            <div>
                              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-[var(--app-muted)]">Type</label>
                              <select
                                value={item.newProduct?.type || 'COSMETIC'}
                                onChange={(event) => updateItem(index, 'newProduct', { ...item.newProduct, type: event.target.value })}
                                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                              >
                                <option value="COSMETIC">Cosmetic</option>
                                <option value="JEWELRY">Jewelry</option>
                              </select>
                            </div>
                            <div>
                              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-[var(--app-muted)]">Category</label>
                              <select
                                value={item.newProduct?.categoryId || ''}
                                onChange={(event) => updateItem(index, 'newProduct', { ...item.newProduct, categoryId: event.target.value })}
                                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                              >
                                <option value="">Select category</option>
                                {categories.map((category) => (
                                  <option key={category.id} value={category.id}>{category.name}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-[var(--app-muted)]">Brand</label>
                              <select
                                value={item.newProduct?.brandId || ''}
                                onChange={(event) => updateItem(index, 'newProduct', { ...item.newProduct, brandId: event.target.value })}
                                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                              >
                                <option value="">No brand</option>
                                {brands.map((brand) => (
                                  <option key={brand.id} value={brand.id}>{brand.name}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-[var(--app-muted)]">Cost price</label>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={item.newProduct?.costPrice || ''}
                                onChange={(event) => updateItem(index, 'newProduct', { ...item.newProduct, costPrice: event.target.value })}
                                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                              />
                            </div>
                            <div>
                              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-[var(--app-muted)]">Sell price</label>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={item.newProduct?.sellPrice || ''}
                                onChange={(event) => updateItem(index, 'newProduct', { ...item.newProduct, sellPrice: event.target.value })}
                                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                              />
                            </div>
                            <div>
                              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-[var(--app-muted)]">Low stock at</label>
                              <input
                                type="number"
                                min="0"
                                step="1"
                                value={item.newProduct?.lowStockAt || ''}
                                onChange={(event) => updateItem(index, 'newProduct', { ...item.newProduct, lowStockAt: event.target.value })}
                                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                              />
                            </div>
                            <div>
                              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-[var(--app-muted)]">Expiry date</label>
                              <input
                                type="date"
                                value={item.newProduct?.expiryDate || ''}
                                onChange={(event) => updateItem(index, 'newProduct', { ...item.newProduct, expiryDate: event.target.value })}
                                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                              />
                            </div>
                          </div>

                          <div className="grid gap-3 md:grid-cols-2">
                            <div>
                              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-[var(--app-muted)]">Qty</label>
                              <input
                                type="number"
                                min="1"
                                step="1"
                                value={item.quantity}
                                onChange={(event) => updateItem(index, 'quantity', event.target.value)}
                                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                              />
                            </div>
                            <div>
                              <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-[var(--app-muted)]">Unit cost</label>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={item.unitCost}
                                onChange={(event) => updateItem(index, 'unitCost', event.target.value)}
                                className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                              />
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="grid gap-3 md:grid-cols-3">
                          <div>
                            <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-[var(--app-muted)]">Product</label>
                            <select
                              value={item.productId}
                              onChange={(event) => updateItem(index, 'productId', event.target.value)}
                              className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                            >
                              <option value="">Select product</option>
                              {products.map((product) => (
                                <option key={product.id} value={product.id}>{product.name}</option>
                              ))}
                            </select>
                            {duplicateError && (
                              <p className="mt-2 text-xs font-medium text-red-600">{duplicateError}</p>
                            )}
                          </div>

                          <div>
                            <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-[var(--app-muted)]">Qty</label>
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={item.quantity}
                              onChange={(event) => updateItem(index, 'quantity', event.target.value)}
                              className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                            />
                          </div>

                          <div>
                            <label className="mb-1.5 block text-xs font-medium uppercase tracking-[0.15em] text-[var(--app-muted)]">Unit cost</label>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={item.unitCost}
                              onChange={(event) => updateItem(index, 'unitCost', event.target.value)}
                              className="w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2.5 text-sm text-[var(--app-text)] outline-none focus:border-indigo-500"
                            />
                          </div>
                        </div>
                      )}

                      <div className="mt-3 text-right text-sm font-medium text-[var(--app-text-soft)]">
                        Line total: {formatCurrency((Number(item.quantity) || 0) * (Number(item.unitCost) || 0))}
                      </div>
                    </div>
                  );
                })}
              </div>

              <button type="button" onClick={addPurchaseItem} className="inline-flex items-center gap-2 rounded-xl border border-dashed border-[var(--app-border)] px-3 py-2 text-sm font-medium text-[var(--app-text-soft)] hover:bg-[var(--app-panel-2)]">
                <Plus className="h-4 w-4" /> Add product
              </button>

              {submitError && (
                <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-900/20 dark:text-red-300">
                  <AlertCircle className="h-4 w-4" />
                  {submitError}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setPurchaseModalOpen(false)} className="rounded-xl border border-[var(--app-border)] px-4 py-2.5 text-sm font-medium text-[var(--app-text-soft)]">
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60">
                  {saving ? 'Saving...' : 'Create purchase'}
                </button>
              </div>
                          </fieldset>
</form>
              </div>
        </div>
      )}

      <PurchaseDetailModal
        purchase={detailPurchase}
        loading={detailLoading}
        error={detailError}
        onClose={() => setDetailModalOpen(false)}
        onRetry={() => {
          setDetailError(null);
          if (detailPurchase?.id) void handleViewPurchase(detailPurchase.id);
        }}
      />
    </div>
  );
}
