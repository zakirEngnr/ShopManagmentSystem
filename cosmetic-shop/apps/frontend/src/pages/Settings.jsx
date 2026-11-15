import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  DatabaseBackup,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Mail,
  RefreshCcw,
  Save,
  Shield,
  SlidersHorizontal,
  Store,
} from 'lucide-react';
import client from '../api/client';

const THEME_STORAGE_KEY = 'shop.settings';
const PROFILE_STORAGE_KEY = 'shop.profile';
const LEGACY_THEME_KEY = 'eshal-theme';
const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

function formatRelativeTime(iso) {
  if (!iso) return 'Never';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Never';

  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return 'just now';

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatBytes(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) || Number(value) <= 0) {
    return '—';
  }

  const bytes = Number(value);
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb >= 10 ? mb.toFixed(1) : mb.toFixed(2)} MB`;
  }

  const kb = bytes / 1024;
  return `${kb >= 10 ? kb.toFixed(1) : kb.toFixed(2)} KB`;
}

function getSystemTheme() {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredSettings() {
  if (typeof window === 'undefined') return { theme: 'system' };

  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return { theme: 'system' };

    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && ['light', 'dark', 'system'].includes(parsed.theme)) {
      return { theme: parsed.theme };
    }
  } catch {
    // Ignore malformed storage and fall back to system theme.
  }

  return { theme: 'system' };
}

const EMPTY_EMAIL_CHANGE = {
  currentPassword: '',
  newEmail: '',
  confirmEmail: '',
};

const EMPTY_PASSWORD_CHANGE = {
  currentPassword: '',
  newPassword: '',
  confirmNewPassword: '',
};

function getDefaultProfile() {
  return {
    shopName: '',
    phone: '',
    address: '',
  };
}

function readProfile() {
  if (typeof window === 'undefined') return getDefaultProfile();

  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return getDefaultProfile();

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return getDefaultProfile();

    return {
      shopName: typeof parsed.shopName === 'string' ? parsed.shopName : '',
      phone: typeof parsed.phone === 'string' ? parsed.phone : '',
      address: typeof parsed.address === 'string' ? parsed.address : '',
    };
  } catch {
    return getDefaultProfile();
  }
}

function SettingCard({ icon: Icon, title, subtitle, children, danger = false }) {
  return (
    <section className={danger ? 'rounded-2xl border border-red-200 dark:border-red-900/40 bg-red-50/40 dark:bg-red-900/10 p-5' : 'rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel)] p-5'}>
      <div className="mb-4 flex items-start gap-3">
        <span className={danger ? 'inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-300' : 'inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300'}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-[var(--app-text)]">{title}</h2>
          <p className="mt-0.5 text-sm text-[var(--app-muted)]">{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

export default function Settings() {
  const [backups, setBackups] = useState([]);
  const [backupCreating, setBackupCreating] = useState(false);
  const [backupLoading, setBackupLoading] = useState(true);
  const [backupError, setBackupError] = useState('');

  const [themePreference, setThemePreference] = useState(() => getStoredSettings().theme);
  const [themeSaved, setThemeSaved] = useState(false);

  const [profile, setProfile] = useState(() => readProfile());
  const [profileSuccess, setProfileSuccess] = useState('');
  const [profileError, setProfileError] = useState('');

  const [accountEmail, setAccountEmail] = useState('');
  const [accountLoading, setAccountLoading] = useState(true);
  const [accountError, setAccountError] = useState('');

  const [emailChange, setEmailChange] = useState(() => ({ ...EMPTY_EMAIL_CHANGE }));
  const [emailChangeLoading, setEmailChangeLoading] = useState(false);
  const [emailChangeSuccess, setEmailChangeSuccess] = useState('');
  const [emailChangeError, setEmailChangeError] = useState('');

  const [passwordChange, setPasswordChange] = useState(() => ({ ...EMPTY_PASSWORD_CHANGE }));
  const [passwordChangeLoading, setPasswordChangeLoading] = useState(false);
  const [passwordChangeSuccess, setPasswordChangeSuccess] = useState('');
  const [passwordChangeError, setPasswordChangeError] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmNewPassword, setShowConfirmNewPassword] = useState(false);

  const [backupDownloadingId, setBackupDownloadingId] = useState(null);

  const themeSavedTimerRef = useRef(null);
  const profileTimerRef = useRef(null);
  const emailChangeTimerRef = useRef(null);
  const passwordChangeTimerRef = useRef(null);

  useEffect(() => {
    setEmailChange({ ...EMPTY_EMAIL_CHANGE });
    setPasswordChange({ ...EMPTY_PASSWORD_CHANGE });
  }, []);

  useEffect(() => {
    return () => {
      if (themeSavedTimerRef.current) clearTimeout(themeSavedTimerRef.current);
      if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
      if (emailChangeTimerRef.current) clearTimeout(emailChangeTimerRef.current);
      if (passwordChangeTimerRef.current) clearTimeout(passwordChangeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const actualTheme = themePreference === 'system' ? getSystemTheme() : themePreference;
    document.documentElement.dataset.theme = actualTheme;
    document.documentElement.style.colorScheme = actualTheme;

    try {
      localStorage.setItem(LEGACY_THEME_KEY, actualTheme);
    } catch {
      // Ignore localStorage write errors for the compatibility key.
    }

    try {
      localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ theme: themePreference }));
    } catch {
      // Ignore localStorage write failures.
    }

    setThemeSaved(true);
    if (themeSavedTimerRef.current) clearTimeout(themeSavedTimerRef.current);
    themeSavedTimerRef.current = setTimeout(() => setThemeSaved(false), 1500);
  }, [themePreference]);

  useEffect(() => {
    if (themePreference !== 'system') return undefined;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      document.documentElement.dataset.theme = getSystemTheme();
      document.documentElement.style.colorScheme = getSystemTheme();
    };

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, [themePreference]);

  const loadBackups = async () => {
    setBackupLoading(true);
    setBackupError('');

    try {
      const response = await client.get('/backups');
      const data = response?.data ?? null;
      const list = Array.isArray(data?.backups) ? data.backups : Array.isArray(data) ? data : [];
      setBackups(list);
    } catch (error) {
      const status = error?.response?.status;
      if (status === 404) {
        setBackups([]);
        setBackupError('Backup service is not available on this server.');
        return;
      }
      setBackupError(error?.response?.data?.error?.message || error?.message || 'Could not load backups.');
    } finally {
      setBackupLoading(false);
    }
  };

  useEffect(() => {
    void loadBackups();
  }, []);

  const handleCreateBackup = async () => {
    if (backupCreating) return;

    setBackupCreating(true);
    setBackupError('');

    try {
      await client.post('/backups');
      await loadBackups();
    } catch (error) {
      const status = error?.response?.status;
      if (status === 404) {
        setBackupError('Backup service is not available on this server.');
        return;
      }
      setBackupError(error?.response?.data?.error?.message || error?.message || 'Backup creation failed.');
    } finally {
      setBackupCreating(false);
    }
  };

  const handleBackupDownload = async (backup) => {
    if (!backup?.filename || backupDownloadingId === backup.id) return;

    setBackupDownloadingId(backup.id);
    setBackupError('');

    try {
      const response = await client.get(`/backups/${encodeURIComponent(backup.filename)}`, {
        responseType: 'blob',
      });

      const contentDisposition = response.headers?.['content-disposition'] || '';
      const match = contentDisposition.match(/filename\s*=\s*"?([^";]+)"?/i);
      const downloadName = match ? decodeURIComponent(match[1]) : backup.filename;
      const blob = new Blob([response.data], {
        type: response.headers?.['content-type'] || 'application/octet-stream',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = downloadName;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setBackupError(error?.response?.data?.error?.message || error?.message || 'Backup download failed.');
    } finally {
      setBackupDownloadingId(null);
    }
  };

  const latestBackup = backups.length > 0 ? backups[0] : null;

  const handleProfileSave = () => {
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
      setProfileSuccess('Shop profile saved.');
      setProfileError('');
      if (profileTimerRef.current) clearTimeout(profileTimerRef.current);
      profileTimerRef.current = setTimeout(() => setProfileSuccess(''), 3000);
    } catch {
      setProfileError('Could not save shop profile in this browser.');
      setProfileSuccess('');
    }
  };

  const handleThemeChange = (nextTheme) => {
    setThemePreference(nextTheme);
  };

  const themeOptions = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ];

  const handleThemeKeyDown = (event) => {
    const index = themeOptions.findIndex((option) => option.value === themePreference);
    if (index === -1) return;

    const moveTo = {
      ArrowRight: index === themeOptions.length - 1 ? 0 : index + 1,
      ArrowDown: index === themeOptions.length - 1 ? 0 : index + 1,
      ArrowLeft: index === 0 ? themeOptions.length - 1 : index - 1,
      ArrowUp: index === 0 ? themeOptions.length - 1 : index - 1,
    }[event.key];

    if (moveTo === undefined) return;

    event.preventDefault();
    handleThemeChange(themeOptions[moveTo].value);
    const nextButton = document.getElementById(`theme-option-${themeOptions[moveTo].value}`);
    nextButton?.focus();
  };

  const loadAccount = async () => {
    setAccountLoading(true);
    setAccountError('');

    try {
      const response = await client.get('/auth/me');
      const user = response?.data?.user ?? null;
      setAccountEmail(user && typeof user.email === 'string' ? user.email : '');
    } catch (error) {
      setAccountError(error?.response?.data?.error?.message || error?.message || 'Could not load account email.');
    } finally {
      setAccountLoading(false);
    }
  };

  useEffect(() => {
    void loadAccount();
  }, []);

  const handleEmailChange = async (event) => {
    event.preventDefault();
    if (emailChangeLoading) return;

    const { currentPassword, newEmail, confirmEmail } = emailChange;

    if (!currentPassword || !newEmail || !confirmEmail) {
      setEmailChangeError('All fields are required.');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      setEmailChangeError('Enter a valid email address.');
      return;
    }

    if (newEmail !== confirmEmail) {
      setEmailChangeError('The new email and confirmation do not match.');
      return;
    }

    setEmailChangeLoading(true);
    setEmailChangeError('');
    setEmailChangeSuccess('');

    try {
      await client.post('/auth/email', {
        currentPassword,
        newEmail,
      });
      setAccountEmail(newEmail);
      setEmailChange({ currentPassword: '', newEmail: '', confirmEmail: '' });
      setEmailChangeSuccess('Email changed successfully.');
      if (emailChangeTimerRef.current) clearTimeout(emailChangeTimerRef.current);
      emailChangeTimerRef.current = setTimeout(() => setEmailChangeSuccess(''), 3000);
    } catch (error) {
      setEmailChangeError(
        error?.response?.data?.error?.message || error?.message || 'Could not change email.',
      );
    } finally {
      setEmailChangeLoading(false);
    }
  };

  const handlePasswordChange = async (event) => {
    event.preventDefault();
    if (passwordChangeLoading) return;

    const { currentPassword, newPassword, confirmNewPassword } = passwordChange;

    if (!currentPassword || !newPassword || !confirmNewPassword) {
      setPasswordChangeError('All fields are required.');
      return;
    }

    if (newPassword.length < 12) {
      setPasswordChangeError('New password must be at least 12 characters.');
      return;
    }

    if (newPassword !== confirmNewPassword) {
      setPasswordChangeError('The new password and confirmation do not match.');
      return;
    }

    setPasswordChangeLoading(true);
    setPasswordChangeError('');
    setPasswordChangeSuccess('');

    try {
      await client.post('/auth/password', {
        currentPassword,
        newPassword,
      });
      setPasswordChange({
        currentPassword: '',
        newPassword: '',
        confirmNewPassword: '',
      });
      setShowCurrentPassword(false);
      setShowNewPassword(false);
      setShowConfirmNewPassword(false);
      setPasswordChangeSuccess('Password changed successfully.');
      if (passwordChangeTimerRef.current) clearTimeout(passwordChangeTimerRef.current);
      passwordChangeTimerRef.current = setTimeout(() => setPasswordChangeSuccess(''), 3000);
    } catch (error) {
      setPasswordChangeError(
        error?.response?.data?.error?.message || error?.message || 'Could not change password.',
      );
    } finally {
      setPasswordChangeLoading(false);
    }
  };

  const lastBackupValue = latestBackup ? formatRelativeTime(latestBackup.createdAt) : 'Never';
  const backupSizeValue = latestBackup ? formatBytes(latestBackup.size) : '—';

  return (
    <div className="space-y-6 max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
      <header className="md:flex md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--app-accent)]">Settings</p>
          <h1 className="mt-2 text-3xl font-extrabold text-[var(--app-text)]">Shop Settings</h1>
          <p className="mt-1 text-sm text-[var(--app-muted)]">Manage backups, preferences, and account details.</p>
        </div>
      </header>

      <SettingCard icon={DatabaseBackup} title="Database backups" subtitle="Encrypted snapshots of your shop data.">
        {backupError && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/10 dark:text-red-300">
            <div className="flex items-center gap-2 font-medium">
              <AlertCircle className="h-4 w-4" />
              {backupError}
            </div>
          </div>
        )}

        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="min-w-0 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">Last backup</p>
            <p className="mt-1 text-sm font-medium text-[var(--app-text)] truncate min-w-0">{lastBackupValue}</p>
            <p className="mt-0.5 text-xs text-[var(--app-muted)] truncate min-w-0">{backupSizeValue}</p>
          </div>
          <div className="min-w-0 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">Available backups</p>
            <p className="mt-1 text-sm font-medium text-[var(--app-text)]">{backups.length}</p>
          </div>
          <div className="min-w-0 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">Download</p>
            {latestBackup ? (
              <button
                type="button"
                onClick={() => handleBackupDownload(latestBackup)}
                disabled={backupDownloadingId === latestBackup.id}
                className="mt-2 inline-flex items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-2.5 py-1.5 text-xs font-medium text-[var(--app-text)] transition disabled:opacity-50 disabled:cursor-not-allowed hover:text-[var(--app-text)]"
              >
                {backupDownloadingId === latestBackup.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {backupDownloadingId === latestBackup.id ? 'Downloading…' : 'Latest backup'}
              </button>
            ) : (
              <p className="mt-1 text-sm text-[var(--app-muted)]">No backups yet</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={backupCreating}
            onClick={handleCreateBackup}
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] px-3.5 py-2 text-sm font-medium text-[var(--app-text)] transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {backupCreating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCcw className="h-4 w-4" />
            )}
            {backupCreating ? 'Creating backup…' : 'Create backup now'}
          </button>
        </div>

        {backups.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">Recent backups</p>
            <ul className="divide-y divide-[var(--app-border)] rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)]">
              {backups.slice(0, 5).map((backup) => (
                <li key={backup.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <DatabaseBackup className="h-4 w-4 text-[var(--app-muted)]" />
                    <p className="truncate min-w-0 text-[var(--app-text)]">{backup.filename}</p>
                  </div>
                  <div className="text-right flex items-center gap-2">
                    <p className="text-xs text-[var(--app-muted)] leading-none">{formatRelativeTime(backup.createdAt)}</p>
                    <button
                      type="button"
                      aria-label={`Download ${backup.filename}`}
                      title="Download backup"
                      onClick={() => handleBackupDownload(backup)}
                      disabled={backupDownloadingId === backup.id}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-muted)] transition hover:text-[var(--app-text)] disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {backupDownloadingId === backup.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={`Copy ${backup.filename}`}
                      title="Copy name"
                      onClick={() => {
                        navigator.clipboard.writeText(backup.filename);
                      }}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-muted)] hover:text-[var(--app-text)] transition"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="mt-4 text-xs text-[var(--app-muted)]">Backups contain customer data. Keep the files private.</p>
      </SettingCard>

      <SettingCard icon={SlidersHorizontal} title="Preferences" subtitle="Appearance and locale.">
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.22em] text-[var(--app-muted)]">Theme</p>
            <div
              className="grid grid-cols-3 gap-1 p-1 mt-2 rounded-xl bg-[var(--app-panel-2)] border border-[var(--app-border)] w-full"
              role="radiogroup"
              aria-label="Theme preference"
              onKeyDown={handleThemeKeyDown}
            >
              {themeOptions.map((option) => {
                const checked = themePreference === option.value;
                return (
                  <button
                    key={option.value}
                    id={`theme-option-${option.value}`}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={checked ? 0 : -1}
                    onClick={() => handleThemeChange(option.value)}
                    className={[
                      'flex-1 py-2 text-sm font-medium rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30',
                      checked
                        ? 'bg-[var(--app-panel)] shadow-sm text-[var(--app-text)]'
                        : 'text-[var(--app-muted)] hover:text-[var(--app-text)]',
                    ].join(' ')}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-panel-2)] p-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[var(--app-text)]">Currency</p>
              <p className="text-sm text-[var(--app-muted)] truncate">Rs. (en-PK)</p>
            </div>
            <span className="inline-flex items-center rounded-md bg-[var(--app-panel-2)] px-2 py-1 text-xs font-medium text-[var(--app-muted)] border border-[var(--app-border)] ml-2 shrink-0">
              Coming soon
            </span>
          </div>
        </div>
      </SettingCard>

      <SettingCard icon={Store} title="Shop profile" subtitle="Shown on receipts and invoices.">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2 min-w-0">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">Shop name</label>
            <input
              value={profile.shopName}
              onChange={(event) => setProfile((current) => ({ ...current, shopName: event.target.value }))}
              className="w-full min-w-0 px-3.5 py-2.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
              placeholder=""
            />
          </div>

          <div className="min-w-0">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">Phone</label>
            <input
              value={profile.phone}
              onChange={(event) => setProfile((current) => ({ ...current, phone: event.target.value }))}
              className="w-full min-w-0 px-3.5 py-2.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
              placeholder=""
            />
          </div>

          <div className="md:col-span-2 min-w-0">
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">Address</label>
            <textarea
              rows={2}
              value={profile.address}
              onChange={(event) => setProfile((current) => ({ ...current, address: event.target.value }))}
              className="w-full min-w-0 px-3.5 py-2.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
              placeholder=""
            />
          </div>
        </div>

        {profileError && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/10 dark:text-red-300">
            <div className="flex items-center gap-2 font-medium">
              <AlertCircle className="h-4 w-4" />
              {profileError}
            </div>
          </div>
        )}

        {profileSuccess && (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-900/10 dark:text-emerald-300">
            <div className="flex items-center gap-2 font-medium">
              <CheckCircle2 className="h-4 w-4" />
              {profileSuccess}
            </div>
          </div>
        )}

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={handleProfileSave}
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500"
          >
            <Save className="h-4 w-4" />
            Save profile
          </button>
        </div>
      </SettingCard>

      <SettingCard icon={Shield} title="Account & Security" subtitle="Manage the owner's login credentials.">
        {accountError && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/10 dark:text-red-300">
            <div className="flex items-center gap-2 font-medium">
              <AlertCircle className="h-4 w-4" />
              {accountError}
            </div>
          </div>
        )}

        <div className="mb-6">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">Current email</p>
          <div className="flex items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] p-3">
            <Mail className="h-5 w-5 text-[var(--app-muted)] shrink-0" />
            <p className="flex-1 min-w-0 text-sm text-[var(--app-text)] truncate">
              {accountLoading ? 'Loading…' : accountEmail || '—'}
            </p>
          </div>
        </div>

        <div className="mb-6">
          <h3 className="text-sm font-semibold text-[var(--app-text)] mb-3">Change email</h3>
          <form onSubmit={handleEmailChange} className="grid gap-4 sm:grid-cols-2">
            <div className="min-w-0">
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
                Current password
              </label>
              <input
                type="password"
                autoComplete="off"
                value={emailChange.currentPassword}
                onChange={(event) =>
                  setEmailChange((current) => ({ ...current, currentPassword: event.target.value }))
                }
                className="w-full min-w-0 px-3.5 py-2.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                placeholder=""
              />
            </div>
            <div className="min-w-0">
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
                New email
              </label>
              <input
                type="email"
                autoComplete="off"
                value={emailChange.newEmail}
                onChange={(event) =>
                  setEmailChange((current) => ({ ...current, newEmail: event.target.value }))
                }
                className="w-full min-w-0 px-3.5 py-2.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                placeholder=""
              />
            </div>
            <div className="sm:col-span-2 min-w-0">
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
                Confirm new email
              </label>
              <input
                type="email"
                autoComplete="off"
                value={emailChange.confirmEmail}
                onChange={(event) =>
                  setEmailChange((current) => ({ ...current, confirmEmail: event.target.value }))
                }
                className="w-full min-w-0 px-3.5 py-2.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                placeholder=""
              />
            </div>
          </form>

          {emailChangeError && (
            <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/10 dark:text-red-300">
              <div className="flex items-center gap-2 font-medium">
                <AlertCircle className="h-4 w-4" />
                {emailChangeError}
              </div>
            </div>
          )}
          {emailChangeSuccess && (
            <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-900/10 dark:text-emerald-300">
              <div className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="h-4 w-4" />
                {emailChangeSuccess}
              </div>
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              disabled={emailChangeLoading}
              onClick={handleEmailChange}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed hover:bg-indigo-500"
            >
              <Save className="h-4 w-4" />
              Save email
            </button>
          </div>
        </div>

        <div className="mb-6">
          <h3 className="text-sm font-semibold text-[var(--app-text)] mb-3">Change password</h3>
          <form onSubmit={handlePasswordChange} className="grid gap-4 sm:grid-cols-3">
            <div className="min-w-0">
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
                Current password
              </label>
              <div className="relative">
                <input
                  type={showCurrentPassword ? 'text' : 'password'}
                  autoComplete="off"
                  value={passwordChange.currentPassword}
                  onChange={(event) =>
                    setPasswordChange((current) => ({ ...current, currentPassword: event.target.value }))
                  }
                  className="w-full min-w-0 pr-10 px-3.5 py-2.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                  placeholder=""
                />
                <button
                  type="button"
                  aria-label={showCurrentPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowCurrentPassword((prev) => !prev)}
                  className="absolute inset-y-0 right-1.5 flex items-center pr-1 text-[var(--app-muted)] hover:text-[var(--app-text)]"
                >
                  {showCurrentPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
            <div className="min-w-0">
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
                New password
              </label>
              <div className="relative">
                <input
                  type={showNewPassword ? 'text' : 'password'}
                  autoComplete="off"
                  value={passwordChange.newPassword}
                  onChange={(event) =>
                    setPasswordChange((current) => ({ ...current, newPassword: event.target.value }))
                  }
                  className="w-full min-w-0 pr-10 px-3.5 py-2.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                  placeholder=""
                />
                <button
                  type="button"
                  aria-label={showNewPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowNewPassword((prev) => !prev)}
                  className="absolute inset-y-0 right-1.5 flex items-center pr-1 text-[var(--app-muted)] hover:text-[var(--app-text)]"
                >
                  {showNewPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
            <div className="min-w-0">
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[var(--app-muted)]">
                Confirm new password
              </label>
              <div className="relative">
                <input
                  type={showConfirmNewPassword ? 'text' : 'password'}
                  autoComplete="off"
                  value={passwordChange.confirmNewPassword}
                  onChange={(event) =>
                    setPasswordChange((current) => ({ ...current, confirmNewPassword: event.target.value }))
                  }
                  className="w-full min-w-0 pr-10 px-3.5 py-2.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-panel-2)] text-sm text-[var(--app-text)] outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                  placeholder=""
                />
                <button
                  type="button"
                  aria-label={showConfirmNewPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowConfirmNewPassword((prev) => !prev)}
                  className="absolute inset-y-0 right-1.5 flex items-center pr-1 text-[var(--app-muted)] hover:text-[var(--app-text)]"
                >
                  {showConfirmNewPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
          </form>

          {passwordChangeError && (
            <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/10 dark:text-red-300">
              <div className="flex items-center gap-2 font-medium">
                <AlertCircle className="h-4 w-4" />
                {passwordChangeError}
              </div>
            </div>
          )}
          {passwordChangeSuccess && (
            <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-900/10 dark:text-emerald-300">
              <div className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="h-4 w-4" />
                {passwordChangeSuccess}
              </div>
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              disabled={passwordChangeLoading}
              onClick={handlePasswordChange}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed hover:bg-indigo-500"
            >
              <Save className="h-4 w-4" />
              Save password
            </button>
          </div>
        </div>
      </SettingCard>

    </div>
  );
}
