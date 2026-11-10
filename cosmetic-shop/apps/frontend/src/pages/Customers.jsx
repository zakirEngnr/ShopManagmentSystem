import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UserPlus,
  X,
  CheckCircle,
  AlertCircle,
  Edit,
  User,
  Banknote,
} from 'lucide-react';
import {
  createCustomer,
  deleteCustomer,
  fetchCustomers,
  recordCustomerDebt,
  updateCustomer,
} from '../api/customers';

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
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
};

const getEmptyForm = () => ({
  name: '',
  phone: '',
  email: '',
  address: '',
  notes: '',
  type: 'RETAIL',
});

const TYPE_BADGE_STYLE = {
  RETAIL: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border border-blue-100 dark:border-blue-800',
  BUSINESS: 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 border border-purple-100 dark:border-purple-800',
  PERSONAL: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-800',
};

const getTypeLabel = (type) => {
  if (type === 'BUSINESS') return 'Business';
  if (type === 'PERSONAL') return 'Personal';
  return 'Retail';
};

export default function Customers() {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);

  const [customerTab, setCustomerTab] = useState('retail'); // 'retail' | 'business-personal'
  const [searchQuery, setSearchQuery] = useState('');
  const searchTimerRef = useRef(null);
  const requestSeqRef = useRef(0);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState(null);
  const [form, setForm] = useState(getEmptyForm());
  const [formErrors, setFormErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [deleteError, setDeleteError] = useState(null);

  const [debtTarget, setDebtTarget] = useState(null);
  const [debtOpen, setDebtOpen] = useState(false);
  const [debtForm, setDebtForm] = useState({ amount: '', description: '' });
  const [debtErrors, setDebtErrors] = useState({});
  const [recordingDebt, setRecordingDebt] = useState(false);
  const [debtError, setDebtError] = useState(null);

  const tabType = useMemo(() => {
    return customerTab === 'retail' ? 'RETAIL' : undefined;
  }, [customerTab]);

  const fetchCustomersPage = useCallback(
    async (search, isRefresh = false) => {
      const requestSeq = ++requestSeqRef.current;
      if (!isRefresh) setLoading(true);
      else setRefreshing(true);
      setError(null);

      try {
        const data = await fetchCustomers({ type: tabType });
        if (requestSeq !== requestSeqRef.current) return;

        const list = Array.isArray(data) ? data : [];
        let filtered = list;
        
        // Filter out RETAIL customers if on Business tab
        if (customerTab === 'business-personal') {
          filtered = filtered.filter((c) => c.type !== 'RETAIL');
        }
        
        // Client-side search filter (since backend might not support it)
        if (search && search.trim()) {
          const q = search.trim().toLowerCase();
          filtered = filtered.filter(
            (c) =>
              String(c?.name ?? '').toLowerCase().includes(q) ||
              String(c?.phone ?? '').includes(q)
          );
        }

        setCustomers(filtered);
        setError(null);
      } catch (err) {
        if (requestSeq !== requestSeqRef.current) return;
        setCustomers([]);
        setError(err?.message || 'Failed to load customers. Please try again.');
      } finally {
        if (requestSeq === requestSeqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [tabType, customerTab]
  );

  useEffect(() => {
    void fetchCustomersPage(searchQuery, false);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [fetchCustomersPage, searchQuery]);

  const handleSearchChange = (value) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      requestSeqRef.current += 1;
      void fetchCustomersPage(value, false);
    }, 300);
  };

  const clearSearch = () => {
    setSearchQuery('');
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    requestSeqRef.current += 1;
    void fetchCustomersPage('', false);
  };

  const handleRefresh = () => {
    requestSeqRef.current += 1;
    void fetchCustomersPage(searchQuery, true);
  };

  const summary = useMemo(() => {
    const totalCustomers = customers.length;
    const totalOutstanding = customers.reduce(
      (sum, c) => sum + Math.max(0, Number(c?.balance ?? 0)),
      0
    );
    const customersWithBalance = customers.filter(
      (c) => Number(c?.balance ?? 0) > 0
    ).length;
    return { totalCustomers, totalOutstanding, customersWithBalance };
  }, [customers]);

  const handleSave = useCallback(() => {
    requestSeqRef.current += 1;
    void fetchCustomersPage(searchQuery, false);
    setModalOpen(false);
    setEditingCustomer(null);
    setForm(getEmptyForm());
    setFormErrors({});
    setSubmitError(null);
    setSuccessMessage(
      editingCustomer
        ? 'Person updated successfully.'
        : 'Person created successfully.'
    );
  }, [searchQuery, fetchCustomersPage, editingCustomer]);

  const validateForm = () => {
    const errors = {};
    if (!form.name || !form.name.trim()) errors.name = 'Name is required.';
    if (form.phone && form.phone.trim().length > 20)
      errors.phone = 'Phone must be at most 20 characters.';
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()))
      errors.email = 'Enter a valid email address.';
    if (form.address && form.address.trim().length > 500)
      errors.address = 'Address must be at most 500 characters.';
    if (form.notes && form.notes.trim().length > 1000)
      errors.notes = 'Notes must be at most 1000 characters.';
    if (!form.type || !['RETAIL', 'BUSINESS', 'PERSONAL'].includes(form.type))
      errors.type = 'Invalid person type.';
    return errors;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errors = validateForm();
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }
    setFormErrors({});
    setSubmitError(null);
    setSaving(true);

    const payload = {
      name: form.name.trim(),
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      address: form.address.trim() || null,
      notes: form.notes.trim() || null,
      type: form.type,
    };

    try {
      if (editingCustomer) {
        await updateCustomer(editingCustomer.id, payload);
      } else {
        await createCustomer(payload);
      }
      handleSave();
    } catch (err) {
      setSubmitError(
        err.response?.data?.error?.message || 'Failed to save person.'
      );
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(deleteTarget.id);
    setDeleteError(null);
    try {
      await deleteCustomer(deleteTarget.id);
      setDeleteTarget(null);
      setDeleting(null);
      requestSeqRef.current += 1;
      void fetchCustomersPage(searchQuery, false);
      setSuccessMessage('Person deleted successfully.');
    } catch (err) {
      setDeleteError(
        err.response?.data?.error?.message ||
          'Failed to delete person. They may have ledger history.'
      );
    } finally {
      setDeleting(null);
    }
  };

  const openDebt = (customer) => {
    setDebtTarget(customer);
    setDebtForm({ amount: '', description: '' });
    setDebtErrors({});
    setDebtError(null);
    setDebtOpen(true);
  };

  const closeDebt = () => {
    setDebtOpen(false);
    setDebtTarget(null);
    setDebtForm({ amount: '', description: '' });
    setDebtErrors({});
    setDebtError(null);
  };

  const validateDebt = () => {
    const errors = {};
    const amountNum = Number(debtForm.amount);
    if (debtForm.amount === '' || debtForm.amount == null)
      errors.amount = 'Amount is required.';
    else if (!Number.isFinite(amountNum) || amountNum <= 0)
      errors.amount = 'Amount must be greater than zero.';
    else if (amountNum > 1e9)
      errors.amount = 'Amount must not exceed 1000000000.';
    if (debtForm.description === '' || !debtForm.description.trim())
      errors.description = 'Description is required.';
    return errors;
  };

  const handleDebtSubmit = async (e) => {
    e.preventDefault();
    const errors = validateDebt();
    if (Object.keys(errors).length > 0) {
      setDebtErrors(errors);
      return;
    }
    setDebtErrors({});
    setDebtError(null);
    setRecordingDebt(true);

    try {
      const result = await recordCustomerDebt(debtTarget.id, {
        amount: debtForm.amount,
        description: debtForm.description,
      });
      setRecordingDebt(false);
      setDebtOpen(false);
      setDebtForm({ amount: '', description: '' });
      setDebtTarget(null);
      setSuccessMessage(
        `Debt of ${formatCurrency(Number(debtForm.amount))} recorded for ${result.customer.name}.`
      );
      requestSeqRef.current += 1;
      void fetchCustomersPage(searchQuery, false);
    } catch (err) {
      setRecordingDebt(false);
      setDebtError(
        err.response?.data?.error?.message || 'Failed to record debt entry.'
      );
    }
  };

  const openCreate = () => {
    setEditingCustomer(null);
    setForm(getEmptyForm());
    setFormErrors({});
    setSubmitError(null);
    setModalOpen(true);
  };

  const openEdit = (customer) => {
    setEditingCustomer(customer);
    setForm({
      name: customer.name ?? '',
      phone: customer.phone ?? '',
      email: customer.email ?? '',
      address: customer.address ?? '',
      notes: customer.notes ?? '',
      type: customer.type ?? 'RETAIL',
    });
    setFormErrors({});
    setSubmitError(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingCustomer(null);
    setForm(getEmptyForm());
    setFormErrors({});
    setSubmitError(null);
  };

  const dismissSuccess = () => setSuccessMessage(null);

  return (
    <div className="space-y-6 max-w-7xl mx-auto animate-fade-in">
      
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-extrabold text-[var(--app-text)] tracking-tight">
            People / Udhaar
          </h2>
          <p className="text-sm text-[var(--app-muted)] mt-1">
            Manage who owes you money (Udhaar)
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-2.5 text-sm font-bold text-[var(--app-text)] transition hover:bg-[var(--app-panel-2)] disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={openCreate}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white shadow-md shadow-indigo-200 hover:bg-indigo-700 transition-colors disabled:opacity-70"
          >
            <Plus className="h-4 w-4" /> Add Person
          </button>
        </div>
      </div>

      {/* Notifications */}
      {successMessage && (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-700 flex items-center gap-2 animate-slide-in shadow-sm">
          <CheckCircle className="h-4 w-4" />
          {successMessage}
          <button onClick={dismissSuccess} className="ml-auto text-green-600 hover:text-green-800 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 flex items-center gap-2 shadow-sm">
          <AlertCircle className="h-4 w-4" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-red-600 hover:text-red-800 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 p-1 bg-[var(--app-panel-2)] rounded-2xl w-fit">
        <button
          type="button"
          onClick={() => setCustomerTab('retail')}
          className={`px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${
            customerTab === 'retail'
              ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-sm'
              : 'text-[var(--app-muted)] hover:text-[var(--app-text)]'
          }`}
        >
          Retail Customers
        </button>
        <button
          type="button"
          onClick={() => setCustomerTab('business-personal')}
          className={`px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${
            customerTab === 'business-personal'
              ? 'bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-sm'
              : 'text-[var(--app-muted)] hover:text-[var(--app-text)]'
          }`}
        >
          Business / Personal
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-sm">
          <p className="text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider">Total People</p>
          <p className="text-3xl font-extrabold text-[var(--app-text)] mt-1">{summary.totalCustomers}</p>
        </div>
        <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-sm">
          <p className="text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider">Total Outstanding</p>
          <p className="text-3xl font-extrabold text-amber-600 mt-1">{formatCurrency(summary.totalOutstanding)}</p>
        </div>
        <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-sm">
          <p className="text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider">People with Udhaar</p>
          <p className="text-3xl font-extrabold text-[var(--app-text)] mt-1">{summary.customersWithBalance}</p>
        </div>
        <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5 shadow-sm">
          <p className="text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider">Search Results</p>
          <p className="text-3xl font-extrabold text-[var(--app-text)] mt-1">{customers.length}</p>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--app-muted)]" />
        <input
          type="text"
          placeholder="Search by name or phone..."
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 bg-[var(--app-panel)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-indigo-500 shadow-sm"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={clearSearch}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--app-muted)] hover:text-red-600 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[var(--app-border)] bg-[var(--app-panel-2)]">
                <th className="px-5 py-4 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider">Person</th>
                <th className="px-5 py-4 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider">Phone</th>
                <th className="px-5 py-4 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider">Email</th>
                <th className="px-5 py-4 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider text-right">Udhaar (Owes You)</th>
                <th className="px-5 py-4 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider">Created</th>
                <th className="px-5 py-4 text-xs font-bold text-[var(--app-muted)] uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--app-border)]">
              {customers.length === 0 && (
                <tr>
                  <td colSpan="6" className="px-5 py-16 text-center">
                    {loading ? (
                      <div className="flex flex-col items-center justify-center gap-2 text-[var(--app-muted)]">
                        <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
                        <p>Loading people...</p>
                      </div>
                    ) : searchQuery ? (
                      <p className="text-sm text-[var(--app-muted)]">No people match your search.</p>
                    ) : (
                      <div className="flex flex-col items-center justify-center gap-3">
                        <UserPlus className="h-10 w-10 text-[var(--app-muted)]" />
                        <p className="text-sm text-[var(--app-muted)]">No people registered yet.</p>
                        <button onClick={openCreate} className="mt-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-2 text-sm font-bold text-[var(--app-text)] hover:bg-[var(--app-panel-2)]">
                          Add Person
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              )}
              {customers.map((customer) => (
                <tr key={customer.id} className="hover:bg-[var(--app-panel-2)]/50 transition-colors">
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-100 to-purple-100 dark:from-indigo-900 dark:to-purple-900 flex items-center justify-center text-indigo-700 dark:text-indigo-300 font-bold text-sm shadow-inner">
                        {customer.name?.charAt(0)?.toUpperCase() || '?'}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-bold text-[var(--app-text)]">{customer.name}</p>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${TYPE_BADGE_STYLE[customer.type ?? 'RETAIL']}`}>
                            {getTypeLabel(customer.type)}
                          </span>
                        </div>
                        <p className="text-[10px] text-[var(--app-muted)] font-medium mt-0.5">ID: #{customer.id}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-sm text-[var(--app-text-soft)]">{customer.phone || '-'}</td>
                  <td className="px-5 py-4 text-sm text-[var(--app-text-soft)]">{customer.email || '-'}</td>
                  <td className="px-5 py-4 text-right">
                    <span className={`text-sm font-bold px-2.5 py-1 rounded-lg border ${
                      Number(customer.balance ?? 0) > 0
                        ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20'
                        : 'bg-green-50 text-green-700 border-green-200 dark:bg-green-500/10 dark:text-green-400 dark:border-green-500/20'
                    }`}>
                      {Number(customer.balance ?? 0) < 0 ? 'Advance Paid' : formatCurrency(customer.balance)}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-sm text-[var(--app-text-soft)]">{formatDate(customer.createdAt)}</td>
                  <td className="px-5 py-4 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => openEdit(customer)} title="Edit" className="p-2 rounded-lg text-[var(--app-muted)] hover:bg-indigo-50 hover:text-indigo-600 transition-colors">
                        <Edit className="h-4 w-4" />
                      </button>
                      {customer.type !== 'RETAIL' && (
                        <button onClick={() => openDebt(customer)} title="Record Debt" className="p-2 rounded-lg text-purple-600 hover:bg-purple-50 hover:text-purple-700 transition-colors">
                          <Banknote className="h-4 w-4" />
                        </button>
                      )}
                      <button onClick={() => { setDeleteTarget(customer); setDeleteError(null); }} title="Delete" className="p-2 rounded-lg text-[var(--app-muted)] hover:bg-red-50 hover:text-red-600 transition-colors">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modals (same as before) */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={closeModal} />
          <div className="relative w-full max-w-lg rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in">
            <div className="flex items-center gap-2 mb-6">
              <UserPlus className="h-5 w-5 text-indigo-600" />
              <h3 className="text-xl font-extrabold text-[var(--app-text)]">
                {editingCustomer ? 'Edit Person' : 'Add Person'}
              </h3>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Person Name</label>
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-indigo-500" placeholder="e.g. Ahmed Traders" />
                {formErrors.name && <p className="mt-1 text-xs text-red-600">{formErrors.name}</p>}
              </div>

              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Person Type</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-indigo-500">
                  <option value="RETAIL">Retail Customer</option>
                  <option value="BUSINESS">Business / Shopkeeper</option>
                  <option value="PERSONAL">Personal / Family / Friend</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Phone Number</label>
                  <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-indigo-500" placeholder="+92 300..." />
                  {formErrors.phone && <p className="mt-1 text-xs text-red-600">{formErrors.phone}</p>}
                </div>
                <div>
                  <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Email (Optional)</label>
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-indigo-500" placeholder="email@example.com" />
                  {formErrors.email && <p className="mt-1 text-xs text-red-600">{formErrors.email}</p>}
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Address</label>
                <input type="text" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-indigo-500" placeholder="Street, City" />
                {formErrors.address && <p className="mt-1 text-xs text-red-600">{formErrors.address}</p>}
              </div>

              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Notes</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-indigo-500" placeholder="Optional notes" />
              </div>

              {submitError && <div className="p-3 bg-red-50 text-red-700 rounded-xl text-sm border border-red-100">{submitError}</div>}

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={closeModal} disabled={saving} className="px-5 py-2.5 rounded-xl font-bold text-[var(--app-text)] bg-[var(--app-panel-2)] hover:bg-[var(--app-panel)] transition-colors">Cancel</button>
                <button type="submit" disabled={saving} className="px-5 py-2.5 rounded-xl font-bold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center gap-2">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {editingCustomer ? 'Save Changes' : 'Create Person'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => !deleting && setDeleteTarget(null)} />
          <div className="relative w-full max-w-sm rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-red-100 text-red-600">
              <Trash2 className="h-6 w-6" />
            </div>
            <h3 className="text-xl font-extrabold text-[var(--app-text)]">Delete Person?</h3>
            <p className="mt-2 text-sm text-[var(--app-muted)]">
              Are you sure you want to delete <strong>{deleteTarget.name}</strong>? This cannot be undone.
            </p>
            {deleteError && <div className="mt-4 p-3 bg-red-50 text-red-700 text-sm rounded-xl border border-red-100 text-left">{deleteError}</div>}
            <div className="mt-6 flex gap-3">
              <button onClick={() => setDeleteTarget(null)} disabled={deleting} className="flex-1 py-2.5 rounded-xl font-bold text-[var(--app-text)] bg-[var(--app-panel-2)] hover:bg-[var(--app-panel)] transition-colors">Cancel</button>
              <button onClick={confirmDelete} disabled={deleting} className="flex-1 py-2.5 rounded-xl font-bold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2">
                {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {debtOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={closeDebt} />
          <div className="relative w-full max-w-md rounded-3xl border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in">
            <div className="flex items-center gap-2 mb-2">
              <Banknote className="h-5 w-5 text-purple-600" />
              <h3 className="text-xl font-extrabold text-[var(--app-text)]">Record Manual Udhaar</h3>
            </div>
            <p className="text-sm text-[var(--app-text-soft)] mb-6">
              Add an owed amount for <strong>{debtTarget?.name}</strong> without linking it to a product sale.
            </p>
            <form onSubmit={handleDebtSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Amount Owed (Rs.)</label>
                <input type="number" min="0" step="0.01" value={debtForm.amount} onChange={(e) => setDebtForm({ ...debtForm, amount: e.target.value })} className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-indigo-500" placeholder="0.00" />
                {debtErrors.amount && <p className="mt-1 text-xs text-red-600">{debtErrors.amount}</p>}
              </div>
              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">Reason / Description</label>
                <input type="text" value={debtForm.description} onChange={(e) => setDebtForm({ ...debtForm, description: e.target.value })} className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-indigo-500" placeholder="e.g., Cash given, stock taken, etc." />
                {debtErrors.description && <p className="mt-1 text-xs text-red-600">{debtErrors.description}</p>}
              </div>
              {debtError && <div className="p-3 bg-red-50 text-red-700 rounded-xl text-sm border border-red-100">{debtError}</div>}
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={closeDebt} disabled={recordingDebt} className="px-5 py-2.5 rounded-xl font-bold text-[var(--app-text)] bg-[var(--app-panel-2)] hover:bg-[var(--app-panel)] transition-colors">Cancel</button>
                <button type="submit" disabled={recordingDebt} className="px-5 py-2.5 rounded-xl font-bold text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50 transition-colors flex items-center gap-2">
                  {recordingDebt ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Record Udhaar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}