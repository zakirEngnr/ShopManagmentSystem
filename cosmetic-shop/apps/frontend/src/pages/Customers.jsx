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
  Menu,
  ChevronDown,
} from 'lucide-react';
import {
  createCustomer,
  deleteCustomer,
  fetchCustomers,
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

const CUSTOMER_TYPE_LABELS = {
  RETAIL: 'Retail Customer',
  BUSINESS: 'Business',
  PERSONAL: 'Personal',
};

const TYPE_BADGE_STYLE = {
  RETAIL: 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border border-blue-100 dark:border-blue-800',
  BUSINESS: 'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 border border-purple-100 dark:border-purple-800',
  PERSONAL: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-800',
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
        if (search && search.trim()) {
          const q = search.trim().toLowerCase();
          filtered = list.filter(
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
    [tabType]
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
        ? 'Customer updated successfully.'
        : 'Customer created successfully.'
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
      errors.type = 'Invalid customer type.';
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
        err.response?.data?.error?.message || 'Failed to save customer.'
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
      setSuccessMessage('Customer deleted successfully.');
    } catch (err) {
      setDeleteError(
        err.response?.data?.error?.message ||
          'Failed to delete customer. This customer may have ledger history.'
      );
    } finally {
      setDeleting(null);
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
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-extrabold text-[var(--app-text)]">
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
            className="flex items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-2.5 text-sm font-medium text-[var(--app-text)] transition hover:bg-[var(--app-panel-2)] disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={openCreate}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--app-accent)] px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:brightness-105 disabled:opacity-70"
          >
            <Plus className="h-4 w-4" /> + Add Person
          </button>
        </div>
      </div>

      {successMessage && (
        <div
          className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-700 flex items-center gap-2 animate-slide-in"
          role="status"
        >
          <CheckCircle className="h-4 w-4" />
          {successMessage}
          <button
            type="button"
            onClick={dismissSuccess}
            className="ml-auto text-[var(--app-muted)] hover:text-green-600 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-auto text-[var(--app-muted)] hover:text-red-600 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setCustomerTab('retail')}
          className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${
            customerTab === 'retail'
              ? 'bg-[var(--app-accent)] text-white shadow-lg'
              : 'bg-[var(--app-panel-2)] border border-[var(--app-border)] text-[var(--app-text-soft)]'
          }`}
        >
          Retail Customers
        </button>
        <button
          type="button"
          onClick={() => setCustomerTab('business-personal')}
          className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${
            customerTab === 'business-personal'
              ? 'bg-[var(--app-accent)] text-white shadow-lg'
              : 'bg-[var(--app-panel-2)] border border-[var(--app-border)] text-[var(--app-text-soft)]'
          }`}
        >
          Business / Personal
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5">
          <p className="text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider">
            Total People
          </p>
          <p className="text-2xl font-bold text-[var(--app-text)] mt-1">
            {summary.totalCustomers}
          </p>
        </div>
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5">
          <p className="text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider">
            Total Outstanding Debt
          </p>
          <p className="text-2xl font-bold text-[var(--app-text)] mt-1">
            {formatCurrency(summary.totalOutstanding)}
          </p>
        </div>
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5">
          <p className="text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider">
            People with Udhaar
          </p>
          <p className="text-2xl font-bold text-[var(--app-text)] mt-1">
            {summary.customersWithBalance}
          </p>
        </div>
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5">
          <p className="text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider">
            Search Results
          </p>
          <p className="text-2xl font-bold text-[var(--app-text)] mt-1">
            {customers.length}
          </p>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--app-muted)]" />
        <input
          type="text"
          placeholder="Search by name or phone..."
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={clearSearch}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--app-muted)] hover:text-red-600 transition-colors"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[var(--app-border)]">
              <th className="px-5 py-3.5 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider bg-[var(--app-panel-2)]/50">
                Person
              </th>
              <th className="px-5 py-3.5 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider bg-[var(--app-panel-2)]/50">
                Phone
              </th>
              <th className="px-5 py-3.5 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider bg-[var(--app-panel-2)]/50">
                Email
              </th>
              <th className="px-5 py-3.5 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider bg-[var(--app-panel-2)]/50 text-right">
                Udhaar (Owes You)
              </th>
              <th className="px-5 py-3.5 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider bg-[var(--app-panel-2)]/50">
                Created
              </th>
              <th className="px-5 py-3.5 text-xs font-semibold text-[var(--app-muted)] uppercase tracking-wider bg-[var(--app-panel-2)]/50">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>

            {customers.length === 0 && (
              <tr>
                <td colSpan="6" className="px-5 py-12 text-center">
                  {loading ? (
                    <div className="flex flex-col items-center justify-center gap-2 text-[var(--app-muted)]">
                      <Loader2 className="h-6 w-6 animate-spin" />
                      <p>Loading customers...</p>
                    </div>
                  ) : error ? (
                    <p className="text-sm text-red-600">
                      {error}. Click Refresh to retry.
                    </p>
                  ) : searchQuery ? (
                    <p className="text-sm text-[var(--app-muted)]">
                      No people match your search.
                    </p>
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-3">
                      <UserPlus className="h-8 w-8 text-[var(--app-muted)]" />
                      <p className="text-sm text-[var(--app-muted)]">
                        No people registered yet. Add someone you've given Udhaar to.
                      </p>
                      <button
                        type="button"
                        onClick={openCreate}
                        className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-2 text-sm font-medium text-[var(--app-text)] transition hover:bg-[var(--app-panel-2)]"
                      >
                        Add Person
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            )}
            {customers.map((customer) => (
              <tr
                key={customer.id}
                className="border-b border-[var(--app-border)]/50 hover:bg-[var(--app-panel-2)]/30 transition-colors"
              >
                <td className="px-5 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900 flex items-center justify-center text-indigo-700 dark:text-indigo-300 font-bold text-sm">
                      {customer.name?.charAt(0)?.toUpperCase() || '?'}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[var(--app-text)]">
                        {customer.name}
                      </p>
                      <p className="text-xs text-[var(--app-muted)]">
                        #{customer.id}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-4">
                  <span
                    className={`text-xs font-bold px-2 py-1 rounded-full border ${TYPE_BADGE_STYLE[customer.type ?? 'RETAIL']}`}
                  >
                    {customer.type === 'RETAIL' ? 'Retail' : customer.type === 'BUSINESS' ? 'Business' : 'Personal'}
                  </span>
                </td>
                <td className="px-5 py-4">
                  <p className="text-sm text-[var(--app-text)]">
                    {customer.phone || '-'}
                  </p>
                </td>
                <td className="px-5 py-4">
                  <p className="text-sm text-[var(--app-text)]">
                    {customer.email || '-'}
                  </p>
                </td>
                <td className="px-5 py-4 text-right">
                  <span
                    className={`text-sm font-bold px-2 py-1 rounded-lg ${
                      Number(customer.balance ?? 0) > 0
                        ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border border-amber-100 dark:border-amber-800'
                        : 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-400 border border-green-100 dark:border-green-800'
                    }`}
                  >
                    {Number(customer.balance ?? 0) < 0 ? 'Advance / Paid Ahead' : formatCurrency(customer.balance)}
                  </span>
                </td>
                <td className="px-5 py-4">
                  <p className="text-sm text-[var(--app-text-soft)]">
                    {formatDate(customer.createdAt)}
                  </p>
                </td>
                <td className="px-5 py-4">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openEdit(customer)}
                      title="Edit person"
                      className="p-2 rounded-md text-[var(--app-muted)] hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteTarget(customer);
                        setDeleteError(null);
                      }}
                      title="Delete person"
                      className="p-2 rounded-md text-[var(--app-muted)] hover:bg-red-50 hover:text-red-600 transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
            onClick={closeModal}
          />
          <div className="relative w-full max-w-lg rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in">
            <div className="flex items-center gap-2 mb-6">
              <UserPlus className="h-5 w-5 text-indigo-600" />
              <h3 className="text-xl font-extrabold text-[var(--app-text)]">
                {editingCustomer ? 'Edit Person' : 'Add Person'}
              </h3>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">
                  Person Name
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) =>
                    setForm({ ...form, name: e.target.value })
                  }
                  className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]"
                  placeholder="e.g. Ahmed Traders"
                />
                {formErrors.name && (
                  <p className="mt-1 text-xs font-medium text-red-600">
                    {formErrors.name}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">
                  Customer Type
                </label>
                <select
                  value={form.type}
                  onChange={(e) =>
                    setForm({ ...form, type: e.target.value })
                  }
                  className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]"
                >
                  <option value="RETAIL">Retail Customer</option>
                  <option value="BUSINESS">Business</option>
                  <option value="PERSONAL">Personal</option>
                </select>
                {formErrors.type && (
                  <p className="mt-1 text-xs font-medium text-red-600">
                    {formErrors.type}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">
                    Phone Number (optional)
                  </label>
                  <input
                    type="tel"
                    value={form.phone}
                    onChange={(e) =>
                      setForm({ ...form, phone: e.target.value })
                    }
                    className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]"
                    placeholder="+92 300 0000000"
                  />
                  {formErrors.phone && (
                    <p className="mt-1 text-xs font-medium text-red-600">
                      {formErrors.phone}
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">
                    Email
                  </label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) =>
                      setForm({ ...form, email: e.target.value })
                    }
                    className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]"
                    placeholder="customer@example.com"
                  />
                  {formErrors.email && (
                    <p className="mt-1 text-xs font-medium text-red-600">
                      {formErrors.email}
                    </p>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">
                  Address
                </label>
                <input
                  type="text"
                  value={form.address}
                  onChange={(e) =>
                    setForm({ ...form, address: e.target.value })
                  }
                  className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]"
                  placeholder="Street, City"
                />
                {formErrors.address && (
                  <p className="mt-1 text-xs font-medium text-red-600">
                    {formErrors.address}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-semibold text-[var(--app-text-soft)] mb-1">
                  Notes
                </label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-2 bg-[var(--app-panel-2)] border border-[var(--app-border)] rounded-xl text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]"
                  placeholder="Optional notes about this person"
                />
                {formErrors.notes && (
                  <p className="mt-1 text-xs font-medium text-red-600">
                    {formErrors.notes}
                  </p>
                )}
              </div>

              {submitError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                  {submitError}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={saving}
                  className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-4 py-2.5 text-sm font-bold text-[var(--app-text)] transition hover:bg-[var(--app-panel)] disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-xl bg-[var(--app-accent)] px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:brightness-105 disabled:opacity-70"
                >
                  {saving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Plus className="h-4 w-4" />
                      {editingCustomer ? 'Save Changes' : 'Create Person'}
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
            onClick={() => !deleting && setDeleteTarget(null)}
          />
          <div className="relative w-full max-w-md rounded-[28px] border border-[var(--app-border)] bg-[var(--app-panel)] p-6 shadow-2xl animate-pop-in">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 text-red-600">
              <Trash2 className="h-5 w-5" />
            </div>
            <h3 className="text-center text-xl font-extrabold text-[var(--app-text)]">
              Delete Person?
            </h3>
            <p className="mt-2 text-center text-sm text-[var(--app-muted)]">
              This will permanently remove{' '}
              <span className="font-bold text-[var(--app-text)]">
                {deleteTarget.name}
              </span>{' '}
              from the person list.
            </p>

            {deleteError && (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
                {deleteError}
              </div>
            )}

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="flex-1 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-4 py-2.5 text-sm font-bold text-[var(--app-text)] transition hover:bg-[var(--app-panel)] disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleting}
                className="flex-1 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-red-700 disabled:opacity-70"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

