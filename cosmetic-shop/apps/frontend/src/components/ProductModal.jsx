import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import {
  createProduct,
  deleteProduct,
  updateProduct,
  uploadProductImage,
} from '../api/products';

const PRODUCT_TYPES = [
  { value: 'COSMETIC', label: 'Cosmetic' },
  { value: 'JEWELRY', label: 'Jewelry' },
];

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const initialForm = () => ({
  name: '',
  sku: '',
  barcode: '',
  type: 'COSMETIC',
  costPrice: '',
  sellPrice: '',
  stock: '',
  lowStockAt: '',
  expiryDate: '',
  categoryId: '',
  brandId: '',
});

export default function ProductModal({
  isOpen,
  onClose,
  product = null,
  onSaved,
  categories = [],
  brands = [],
}) {
  const [form, setForm] = useState(initialForm());
  const [originalProduct, setOriginalProduct] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const saveRef = useRef(false);
  const uploadRef = useRef(false);
  const deleteRef = useRef(false);

  const isEdit = product != null && product.id != null;

  // Initialize / reset the form whenever the modal opens or the product changes.
  useEffect(() => {
    if (!isOpen) return;
    setOriginalProduct(isEdit ? product : null);
    if (isEdit) {
      setForm({
        name: product.name ?? '',
        sku: product.sku ?? '',
        barcode: product.barcode ?? '',
        type: product.type ?? 'COSMETIC',
        costPrice: String(product.costPrice ?? ''),
        sellPrice: String(product.sellPrice ?? ''),
        lowStockAt: String(product.lowStockAt ?? ''),
        expiryDate: product.expiryDate ? String(product.expiryDate).slice(0, 10) : '',
        categoryId: String(product.categoryId ?? ''),
        brandId: product.brandId != null ? String(product.brandId) : '',
        // Stock is read-only in edit mode and not part of the update payload.
        stock: '',
      });
      setImagePreview(product.imageUrl || null);
    } else {
      setForm(initialForm());
      setImagePreview(null);
    }
    setSaveError(null);
    setUploadError(null);
    setDeleteError(null);
    setDeleteConfirm(false);
  }, [isOpen, product, isEdit]);

  // Close on Escape key while the modal is open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const setField = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    // Clear field-level save errors as the user edits.
    if (saveError) setSaveError(null);
  };

  const validateForm = useCallback(() => {
    const errors = {};

    if (!form.name.trim()) errors.name = 'Product name is required.';
    if (!form.sku.trim()) errors.sku = 'SKU is required.';
    else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(form.sku)) {
      errors.sku = 'Invalid SKU format.';
    }
    if (!form.categoryId) errors.categoryId = 'Category is required.';
    if (!form.type) errors.type = 'Product type is required.';

    const cost = Number(form.costPrice);
    if (!Number.isFinite(cost) || cost < 0) {
      errors.costPrice = 'Enter a valid non-negative cost price.';
    }

    const sell = Number(form.sellPrice);
    if (!Number.isFinite(sell) || sell < 0) {
      errors.sellPrice = 'Enter a valid non-negative sell price.';
    }

    if (form.lowStockAt !== '' && form.lowStockAt != null) {
      const low = Number(form.lowStockAt);
      if (!Number.isInteger(low) || low < 0) {
        errors.lowStockAt = 'Low stock alert must be a whole number >= 0.';
      }
    }

    if (form.expiryDate && Number.isNaN(Date.parse(form.expiryDate))) {
      errors.expiryDate = 'Enter a valid expiry date.';
    }

    return errors;
  }, [form]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (saveRef.current) return;

    const errors = validateForm();
    if (Object.keys(errors).length > 0) {
      setSaveError('Please fix the highlighted fields before saving.');
      return;
    }

    saveRef.current = true;
    setSaving(true);
    setSaveError(null);

    try {
      const payload = {
        name: form.name.trim(),
        sku: form.sku.trim(),
        barcode: form.barcode.trim() || undefined,
        type: form.type,
        costPrice: Number(form.costPrice),
        sellPrice: Number(form.sellPrice),
        lowStockAt:
          form.lowStockAt === '' || form.lowStockAt == null
            ? undefined
            : Number(form.lowStockAt),
        expiryDate: form.expiryDate || undefined,
        categoryId: Number(form.categoryId),
        brandId: form.brandId === '' || form.brandId == null ? undefined : Number(form.brandId),
      };

      // Initial stock is only sent when creating a product.
      if (!isEdit && form.stock !== '' && form.stock != null) {
        const stock = Number(form.stock);
        if (Number.isInteger(stock) && stock >= 0) {
          payload.stock = stock;
        }
      }

      const result = isEdit
        ? await updateProduct(originalProduct.id, payload)
        : await createProduct(payload);

      if (!saveRef.current) return; // modal was closed / reset mid-flight

      onSaved?.(result.product);
      onClose();
    } catch (err) {
      if (!saveRef.current) return;
      setSaveError(
        err?.message || 'Could not save the product. Please try again.'
      );
    } finally {
      if (saveRef.current) {
        setSaving(false);
        saveRef.current = false;
      }
    }
  };

  const handleImageChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setUploadError('Only JPEG, PNG and WebP images are supported.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setUploadError('Image must be smaller than 2 MB.');
      return;
    }

    if (uploadRef.current) return;
    uploadRef.current = true;
    setUploading(true);
    setUploadError(null);

    try {
      const result = await uploadProductImage(originalProduct.id, file);
      if (!uploadRef.current) return;
      setImagePreview(result.product?.imageUrl || URL.createObjectURL(file));
    } catch (err) {
      if (!uploadRef.current) return;
      setUploadError(
        err?.message || 'Image upload failed. Please try again.'
      );
    } finally {
      if (uploadRef.current) {
        setUploading(false);
        uploadRef.current = false;
        // Reset the file input so the same file can be re-selected.
        e.target.value = '';
      }
    }
  };

  const handleDelete = async () => {
    if (deleteRef.current) return;

    deleteRef.current = true;
    setDeleting(true);
    setDeleteError(null);

    try {
      await deleteProduct(originalProduct.id);
      if (!deleteRef.current) return;
      onClose();
      onSaved?.(null); // signals the parent to refresh the product list
    } catch (err) {
      if (!deleteRef.current) return;
      setDeleteError(
        err?.message || 'Could not delete the product. Please try again.'
      );
    } finally {
      if (deleteRef.current) {
        setDeleting(false);
        deleteRef.current = false;
      }
    }
  };

  if (!isOpen) return null;

  const currentImage = imagePreview || (isEdit ? product?.imageUrl : null);
  const currentStock = isEdit ? product?.stock : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? 'Edit product' : 'Add product'}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal panel */}
      <div
        className="w-full max-w-lg mx-4 rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--app-border)] bg-[var(--app-panel-2)]">
          <h2 className="text-lg font-bold text-[var(--app-text)]">
            {isEdit ? 'Edit Product' : 'Add New Product'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-xl p-2 text-[var(--app-text-soft)] hover:bg-[var(--app-border)] transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {saveError && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {saveError}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-[var(--app-text-soft)]">
                Product Name
              </label>
              <input
                type="text"
                name="name"
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
                className="block w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2.5 text-sm text-[var(--app-text)] focus:border-indigo-500 focus:outline-none transition-colors"
                placeholder="e.g. Organic Face Serum"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-[var(--app-text-soft)]">
                SKU
              </label>
              <input
                type="text"
                name="sku"
                value={form.sku}
                onChange={(e) => setField('sku', e.target.value)}
                className="block w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2.5 text-sm text-[var(--app-text)] focus:border-indigo-500 focus:outline-none transition-colors"
                placeholder="e.g. SER-001"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-[var(--app-text-soft)]">
                Barcode (optional)
              </label>
              <input
                type="text"
                name="barcode"
                value={form.barcode}
                onChange={(e) => setField('barcode', e.target.value)}
                className="block w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2.5 text-sm text-[var(--app-text)] focus:border-indigo-500 focus:outline-none transition-colors"
                placeholder="e.g. 8901234567"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-[var(--app-text-soft)]">
                Type
              </label>
              <select
                name="type"
                value={form.type}
                onChange={(e) => setField('type', e.target.value)}
                className="block w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2.5 text-sm text-[var(--app-text)] focus:border-indigo-500 focus:outline-none transition-colors"
              >
                {PRODUCT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-[var(--app-text-soft)]">
                Category
              </label>
              <select
                name="categoryId"
                value={form.categoryId}
                onChange={(e) => setField('categoryId', e.target.value)}
                className="block w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2.5 text-sm text-[var(--app-text)] focus:border-indigo-500 focus:outline-none transition-colors"
              >
                <option value="">Select category</option>
                {categories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-[var(--app-text-soft)]">
                Brand (optional)
              </label>
              <select
                name="brandId"
                value={form.brandId}
                onChange={(e) => setField('brandId', e.target.value)}
                className="block w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2.5 text-sm text-[var(--app-text)] focus:border-indigo-500 focus:outline-none transition-colors"
              >
                <option value="">Select brand</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-[var(--app-text-soft)]">
                Cost Price
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                name="costPrice"
                value={form.costPrice}
                onChange={(e) => setField('costPrice', e.target.value)}
                className="block w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2.5 text-sm text-[var(--app-text)] focus:border-indigo-500 focus:outline-none transition-colors"
                placeholder="0.00"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-[var(--app-text-soft)]">
                Sell Price
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                name="sellPrice"
                value={form.sellPrice}
                onChange={(e) => setField('sellPrice', e.target.value)}
                className="block w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2.5 text-sm text-[var(--app-text)] focus:border-indigo-500 focus:outline-none transition-colors"
                placeholder="0.00"
              />
            </div>

            {!isEdit && (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-[var(--app-text-soft)]">
                  Initial Stock
                </label>
                <input
                  type="number"
                  min="0"
                  name="stock"
                  value={form.stock}
                  onChange={(e) => setField('stock', e.target.value)}
                  className="block w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2.5 text-sm text-[var(--app-text)] focus:border-indigo-500 focus:outline-none transition-colors"
                  placeholder="0"
                />
                <p className="text-[10px] text-[var(--app-muted)]">
                  Optional initial stock for new products only.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <label className="block text-sm font-medium text-[var(--app-text-soft)]">
                Low Stock Alert
              </label>
              <input
                type="number"
                min="0"
                name="lowStockAt"
                value={form.lowStockAt}
                onChange={(e) => setField('lowStockAt', e.target.value)}
                className="block w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2.5 text-sm text-[var(--app-text)] focus:border-indigo-500 focus:outline-none transition-colors"
                placeholder="5"
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-[var(--app-text-soft)]">
                Expiry Date (optional)
              </label>
              <input
                type="date"
                name="expiryDate"
                value={form.expiryDate}
                onChange={(e) => setField('expiryDate', e.target.value)}
                className="block w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2.5 text-sm text-[var(--app-text)] focus:border-indigo-500 focus:outline-none transition-colors"
              />
            </div>
          </div>

          {/* Image upload (existing products only) */}
          {isEdit && (
            <div className="space-y-3 border-t border-[var(--app-border)] pt-4">
              <div className="flex items-center gap-2">
                <Image className="h-5 w-5 text-[var(--app-text-soft)]" />
                <h3 className="text-sm font-semibold text-[var(--app-text)]">
                  Product Image
                </h3>
              </div>

              <div className="flex items-center gap-4">
                <div className="relative group">
                  {currentImage ? (
                    <img
                      src={currentImage}
                      alt="Product"
                      className="w-24 h-24 rounded-xl object-cover border border-[var(--app-border)]"
                    />
                  ) : (
                    <div className="w-24 h-24 rounded-xl border-2 border-dashed border-[var(--app-border)] flex items-center justify-center bg-[var(--app-bg)]/50">
                      <Image className="h-8 w-8 text-[var(--app-muted)]" />
                    </div>
                  )}
                  <label className="absolute bottom-1 right-1 flex items-center justify-center w-8 h-8 rounded-full bg-white border border-[var(--app-border)] shadow-sm hover:bg-indigo-50 cursor-pointer transition-colors">
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={handleImageChange}
                      disabled={uploading}
                      className="sr-only"
                    />
                    <Plus className="h-4 w-4 text-indigo-600" />
                  </label>
                </div>

                {uploading && (
                  <div className="flex items-center gap-2 text-sm text-[var(--app-text-soft)]">
                    <RefreshCw className="h-4 w-4 animate-spin text-indigo-600" />
                    Uploading...
                  </div>
                )}

                {uploadError && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
                    {uploadError}
                  </div>
                )}
              </div>
            </div>
          )}

          {isEdit && currentStock != null && (
            <div className="space-y-2 border-t border-[var(--app-border)] pt-4">
              <span className="block text-sm font-medium text-[var(--app-text-soft)]">
                Current Stock
              </span>
              <span className="text-lg font-bold text-[var(--app-text)]">
                {currentStock}
              </span>
              <p className="text-xs text-[var(--app-muted)]">
                Stock is changed through the Adjust Stock workflow, not here.
              </p>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 pt-4 border-t border-[var(--app-border)]">
            <button
              type="button"
              onClick={onClose}
              disabled={saving || uploading || deleting}
              className="px-5 py-2.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-text)] font-medium hover:bg-[var(--app-border)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              Cancel
            </button>

            <div className="flex items-center gap-2">
              {isEdit && (
                <button
                  type="button"
                  onClick={() => setDeleteConfirm(true)}
                  disabled={saving || uploading || deleting}
                  className="px-5 py-2.5 rounded-xl border border-red-200 bg-red-50 text-red-700 font-medium hover:bg-red-100 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Delete
                </button>
              )}

              <button
                type="submit"
                disabled={saving || uploading || deleting}
                className="px-6 py-2.5 rounded-xl bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors shadow-md shadow-indigo-200"
              >
                {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Product'}
              </button>
            </div>
          </div>
        </form>

        {/* Delete confirmation */}
        {deleteConfirm && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10">
            <div className="rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] shadow-2xl p-6 w-full max-w-sm">
              <h3 className="text-base font-bold text-[var(--app-text)] mb-2">
                Delete Product?
              </h3>
              <p className="text-sm text-[var(--app-text-soft)] mb-6">
                This will remove the product and its image. This cannot be undone
                if the product has no sales or stock history.
              </p>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setDeleteConfirm(false)}
                  disabled={deleting}
                  className="px-5 py-2.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-text)] font-medium hover:bg-[var(--app-border)] transition-colors disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="px-5 py-2.5 rounded-xl border border-red-200 bg-red-600 text-red-50 font-medium hover:bg-red-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {deleting ? 'Deleting...' : 'Delete'}
                </button>
              </div>

              {deleteError && (
                <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {deleteError}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
