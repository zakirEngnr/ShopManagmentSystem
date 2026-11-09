import { useEffect, useState } from 'react';
import { X, Upload, Loader2, Save, Image as ImageIcon } from 'lucide-react';
import {
  createProduct,
  updateProduct,
  uploadProductImage,
} from '../api/products';

const createEmptyForm = () => ({
  name: '',
  sku: '',
  barcode: '',
  categoryId: '',
  brandId: '',
  costPrice: '',
  sellPrice: '',
  stock: '',
  lowStockAt: 5,
  expiryDate: '',
});

export default function ProductModal({ isOpen, onClose, product, onSaved, categories, brands }) {
  const [formData, setFormData] = useState(createEmptyForm());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [selectedImage, setSelectedImage] = useState(null);
  const [imagePreview, setImagePreview] = useState('');

  const isEditing = !!product;

  const generateSku = (catId) => {
    const cat = categories.find((c) => c.id === Number(catId));
    const prefix = cat ? cat.name.substring(0, 3).toUpperCase() : 'PRD';
    const timestamp = Date.now().toString().slice(-6);
    return `${prefix}-${timestamp}`;
  };

  const getProductType = (catId) => {
    const cat = categories.find((c) => c.id === Number(catId));
    if (!cat) return 'COSMETIC';
    const name = cat.name.toLowerCase();
    if (name.includes('jewel')) return 'JEWELRY';
    return 'COSMETIC';
  };

  useEffect(() => {
    if (!isOpen) return;

    if (product) {
      setFormData({
        name: product.name || '',
        sku: product.sku || '',
        barcode: product.barcode || '',
        categoryId: product.categoryId || '',
        brandId: product.brandId || '',
        costPrice: product.costPrice || '',
        sellPrice: product.sellPrice || '',
        stock: product.stock || '',
        lowStockAt: product.lowStockAt || 5,
        expiryDate: product.expiryDate ? product.expiryDate.split('T')[0] : '',
      });
      setImagePreview(product.imageUrl || '');
    } else {
      setFormData(createEmptyForm());
      setImagePreview('');
    }

    setSelectedImage(null);
    setError('');
  }, [isOpen, product]);

  useEffect(() => {
    return () => {
      if (imagePreview && imagePreview.startsWith('blob:')) {
        URL.revokeObjectURL(imagePreview);
      }
    };
  }, [imagePreview]);

  if (!isOpen) return null;

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => {
      const newData = { ...prev, [name]: value };
      if (name === 'categoryId' && !isEditing && value) {
        newData.sku = generateSku(value);
      }
      return newData;
    });
  };

  const handleImageSelect = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (imagePreview.startsWith('blob:')) {
      URL.revokeObjectURL(imagePreview);
    }

    setSelectedImage(file);
    setImagePreview(URL.createObjectURL(file));
    event.target.value = '';
  };

  const handleImageRemove = () => {
    if (imagePreview.startsWith('blob:')) {
      URL.revokeObjectURL(imagePreview);
    }
    setSelectedImage(null);
    setImagePreview(product?.imageUrl || '');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    let finalSku = formData.sku;
    if (!isEditing && !finalSku) {
      finalSku = `PRD-${Date.now().toString().slice(-6)}`;
    }

    const payload = {
      name: formData.name,
      sku: finalSku,
      barcode: formData.barcode || null,
      categoryId: Number(formData.categoryId),
      brandId: formData.brandId ? Number(formData.brandId) : null,
      costPrice: Number(formData.costPrice),
      sellPrice: Number(formData.sellPrice),
      lowStockAt: Number(formData.lowStockAt),
      expiryDate: formData.expiryDate || null,
      type: getProductType(formData.categoryId),
    };

    if (!isEditing) {
      payload.stock = Number(formData.stock);
    }

    try {
      const saved = isEditing
        ? await updateProduct(product.id, payload)
        : await createProduct(payload);

      const targetId = saved?.product?.id ?? product?.id;
      if (targetId && selectedImage) {
        setUploading(true);
        await uploadProductImage(targetId, selectedImage);
      }

      onSaved();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to save product.');
    } finally {
      setLoading(false);
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-2xl bg-[var(--app-panel)] rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-pop-in border border-[var(--app-border)]">
        <div className="p-6 border-b border-[var(--app-border)] flex justify-between items-center bg-[var(--app-panel-2)]">
          <h2 className="text-xl font-bold text-[var(--app-text)]">
            {isEditing ? 'Edit Product' : 'Add New Product'}
          </h2>
          <button onClick={onClose} className="p-2 rounded-xl text-[var(--app-muted)] hover:bg-[var(--app-panel)] transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto">
          {error && (
            <div className="mb-6 p-4 bg-red-50 text-red-600 rounded-xl text-sm font-medium border border-red-200">
              {error}
            </div>
          )}

          <form id="productForm" onSubmit={handleSubmit} className="space-y-5">
            <div className="flex items-center gap-4 p-4 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-2)]">
              <div className="w-20 h-20 rounded-xl bg-[var(--app-panel)] border border-[var(--app-border)] flex items-center justify-center overflow-hidden">
                {imagePreview ? (
                  <img src={imagePreview} alt="Product preview" className="w-full h-full object-cover" />
                ) : (
                  <ImageIcon className="h-8 w-8 text-[var(--app-muted)]" />
                )}
              </div>

              <div className="flex-1">
                <p className="text-sm font-bold text-[var(--app-text)] mb-2">Product photo</p>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="cursor-pointer inline-flex items-center gap-2 px-4 py-2 bg-[var(--app-panel)] border border-[var(--app-border)] rounded-lg text-sm font-bold text-[var(--app-text)] hover:border-indigo-500 hover:text-indigo-600 transition-colors">
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    {uploading ? 'Uploading...' : 'Upload photo'}
                    <input type="file" accept="image/*" className="hidden" onChange={handleImageSelect} disabled={uploading || loading} />
                  </label>

                  {(imagePreview || selectedImage) && (
                    <button
                      type="button"
                      onClick={handleImageRemove}
                      className="px-3 py-2 rounded-lg text-sm font-medium text-[var(--app-text-soft)] hover:bg-[var(--app-panel)] border border-[var(--app-border)] transition-colors"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 sm:col-span-1">
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Product Name *</label>
                <input required name="name" value={formData.name} onChange={handleChange} className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl focus:ring-2 focus:ring-indigo-500 text-[var(--app-text)] outline-none" />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Category *</label>
                <select required name="categoryId" value={formData.categoryId} onChange={handleChange} className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl focus:ring-2 focus:ring-indigo-500 text-[var(--app-text)] outline-none">
                  <option value="">Select Category</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div className="col-span-2 sm:col-span-1">
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Barcode</label>
                <input name="barcode" value={formData.barcode} onChange={handleChange} className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl focus:ring-2 focus:ring-indigo-500 text-[var(--app-text)] outline-none" placeholder="Scan or type barcode" />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Brand</label>
                <select name="brandId" value={formData.brandId} onChange={handleChange} className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl focus:ring-2 focus:ring-indigo-500 text-[var(--app-text)] outline-none">
                  <option value="">No Brand</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>

              <div className="col-span-2 sm:col-span-1">
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Expiry Date</label>
                <input type="date" name="expiryDate" value={formData.expiryDate} onChange={handleChange} className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl focus:ring-2 focus:ring-indigo-500 text-[var(--app-text)] outline-none" />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Low Stock Alert</label>
                <input type="number" name="lowStockAt" value={formData.lowStockAt} onChange={handleChange} className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl focus:ring-2 focus:ring-indigo-500 text-[var(--app-text)] outline-none" />
              </div>

              <div className="col-span-2 grid grid-cols-2 gap-4 p-4 bg-indigo-50/60 rounded-2xl border border-indigo-100">
                <div>
                  <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Cost Price (Rs) *</label>
                  <input type="number" step="0.01" required name="costPrice" value={formData.costPrice} onChange={handleChange} className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 text-slate-900 outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Sell Price (Rs) *</label>
                  <input type="number" step="0.01" required name="sellPrice" value={formData.sellPrice} onChange={handleChange} className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 text-slate-900 outline-none" />
                </div>
              </div>

              <div className="col-span-2">
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Initial Stock</label>
                <input type="number" disabled={isEditing} required={!isEditing} name="stock" value={formData.stock} onChange={handleChange} className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl focus:ring-2 focus:ring-indigo-500 text-[var(--app-text)] outline-none disabled:opacity-50 disabled:cursor-not-allowed" />
                {isEditing && (
                  <p className="text-xs text-amber-600 mt-1 font-medium">Stock cannot be edited here. Use the Adjust Stock button on the table.</p>
                )}
              </div>
            </div>
          </form>
        </div>

        <div className="p-6 border-t border-[var(--app-border)] bg-[var(--app-panel-2)] flex justify-end gap-3 rounded-b-3xl">
          <button onClick={onClose} disabled={loading} className="px-5 py-2.5 rounded-xl font-bold text-[var(--app-text-soft)] hover:bg-[var(--app-panel)] transition-colors">
            Cancel
          </button>
          <button type="submit" form="productForm" disabled={loading} className="px-6 py-2.5 rounded-xl bg-indigo-600 text-white font-bold hover:bg-indigo-700 disabled:opacity-50 transition-colors shadow-lg shadow-indigo-200 flex items-center gap-2">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {loading ? 'Saving...' : 'Save Product'}
          </button>
        </div>
      </div>
    </div>
  );
}