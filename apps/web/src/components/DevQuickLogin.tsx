import { ROLE_KEYS, ROLE_LABELS } from '@mmp/shared';
import React, { useRef, useState } from 'react';
import { Repeat, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useDialogFocus } from '../lib/useDialogFocus';
import { homePathFor } from '../lib/access';

/**
 * Quick sign in and Switch account: LOCAL DEVELOPMENT ONLY.
 * Every caller renders these behind `import.meta.env.DEV`, which Vite replaces with false in a
 * production build, so this module, its text and the account list are left out of the bundle
 * (Phase9QuickLoginBuild.test builds the app and checks). The accounts come from
 * VITE_QUICK_LOGINS in the git-ignored apps/web/.env.local, written by
 * `node apps/api/scripts/write-quick-logins.js`.
 */

export interface QuickLoginAccount {
  label: string;
  email: string;
  password: string;
  role?: string;
  jobRole?: string;
}

const valid = (a: any): a is QuickLoginAccount =>
  a && typeof a.label === 'string' && typeof a.email === 'string' && typeof a.password === 'string';

/**
 * Reads VITE_QUICK_LOGINS: base64 of JSON, either `{ v: 2, accounts: [...] }` (current, from the
 * script) or a plain list (older). A bad value gives no buttons.
 */
export function parseQuickLogins(raw: unknown): QuickLoginAccount[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const bytes = Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0));
    const data = JSON.parse(new TextDecoder().decode(bytes));
    const list = Array.isArray(data) ? data : Array.isArray(data?.accounts) ? data.accounts : [];
    return list.filter(valid);
  } catch {
    return [];
  }
}

/** The dev accounts, read only in the dev server. */
export const devQuickLogins = (): QuickLoginAccount[] =>
  import.meta.env.DEV && import.meta.env.MODE !== 'test' ? parseQuickLogins(import.meta.env.VITE_QUICK_LOGINS) : [];

/** "Test Writer One · Writer"; the name alone without a job role. */
export const quickLoginLabel = (a: QuickLoginAccount) => (a.jobRole?.trim() ? `${a.label} · ${a.jobRole.trim()}` : a.label);

/** Where each role lands after signing in (the same rule as the login page). */
export const homeForRole = (role: string | undefined) => homePathFor({ role, status: 'active' });

/** The 7 role groups, in order; accounts without a known role go under "Other". */
export const QUICK_LOGIN_GROUPS: { role: string; title: string }[] = ROLE_KEYS.map((role) => ({ role, title: ROLE_LABELS[role] }));

export function groupQuickLogins(accounts: QuickLoginAccount[]): { role: string; title: string; accounts: QuickLoginAccount[] }[] {
  const known = new Set(QUICK_LOGIN_GROUPS.map((g) => g.role));
  const groups = QUICK_LOGIN_GROUPS.map((g) => ({ ...g, accounts: accounts.filter((a) => a.role === g.role) }));
  const other = accounts.filter((a) => !a.role || !known.has(a.role));
  return other.length ? [...groups, { role: 'other', title: 'Other', accounts: other }] : groups;
}

/** The grouped chips: one row per role (all 7 shown; a role without a test account says so). */
const QuickLoginGroups: React.FC<{ accounts: QuickLoginAccount[]; busy?: boolean; currentEmail?: string; onPick: (a: QuickLoginAccount) => void }> = ({ accounts, busy, currentEmail, onPick }) => (
  <div className="space-y-2">
    {groupQuickLogins(accounts).map((group) => (
      <div key={group.role} role="group" aria-label={group.title} data-testid="quick-login-group" className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-2">
        <h4 className="shrink-0 sm:w-28 sm:pt-1.5 text-[11px] font-semibold text-ui-muted">{group.title}</h4>
        <div className="flex flex-wrap gap-1.5 min-w-0">
          {group.accounts.length === 0 ? (
            <span className="text-[11px] text-ui-muted italic sm:pt-1.5">No test account</span>
          ) : (
            group.accounts.map((account) => {
              const current = currentEmail?.toLowerCase() === account.email.toLowerCase();
              return (
                <button
                  key={account.email}
                  type="button"
                  disabled={busy || current}
                  title={current ? 'Signed in now' : account.email}
                  onClick={() => onPick(account)}
                  aria-current={current ? 'true' : undefined}
                  className={`min-h-[32px] px-2.5 py-1 rounded-full border text-[11px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-ink disabled:cursor-not-allowed ${
                    current ? 'bg-ui-ink text-white border-ui-ink' : 'bg-white text-ui-ink border-ui-line hover:bg-ui-canvas disabled:opacity-50'
                  }`}
                >
                  {quickLoginLabel(account)}
                </button>
              );
            })
          )}
        </div>
      </div>
    ))}
  </div>
);

/** Login page: "Quick sign in (dev only)" under the Sign In card. */
export const DevQuickLogin: React.FC<{ accounts: QuickLoginAccount[]; busy?: boolean; onPick: (account: QuickLoginAccount) => void }> = ({ accounts, busy, onPick }) => {
  if (accounts.length === 0) return null;
  return (
    <section aria-label="Quick sign in (dev only)" data-testid="dev-quick-login" className="mt-4 w-full p-3 sm:p-4 rounded-3xl bg-white/60 border border-dashed border-ui-line">
      <h3 className="text-xs font-bold text-ui-ink mb-2">
        Quick sign in <span className="font-semibold text-ui-muted">(dev only)</span>
      </h3>
      <QuickLoginGroups accounts={accounts} busy={busy} onPick={onPick} />
    </section>
  );
};

/** Signs out, signs in as the chosen account, then reloads on that role's home page. */
export function useDevSwitchAccount() {
  const { logout, login } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switchTo = async (account: QuickLoginAccount) => {
    setBusy(true);
    setError(null);
    try {
      await logout().catch(() => {});
      const user = await login({ email: account.email, password: account.password });
      window.location.assign(homeForRole(user.role));
    } catch (err: any) {
      setError(`Could not sign in as ${account.label}: ${err?.message || 'unknown error'}`);
      setBusy(false);
    }
  };
  return { switchTo, busy, error };
}

/** Profile menu item "Switch account (dev)"; the menu keeps the dialog open after it closes itself. */
export const DevSwitchAccountItem: React.FC<{ accounts: QuickLoginAccount[]; onClick: () => void; className: string }> = ({ accounts, onClick, className }) => {
  if (accounts.length === 0) return null;
  return (
    <button type="button" role="menuitem" onClick={onClick} className={className} data-testid="dev-switch-account">
      <Repeat className="w-4 h-4 text-ui-muted shrink-0" aria-hidden="true" />
      <span>Switch account (dev)</span>
    </button>
  );
};

export const DevSwitchAccountDialog: React.FC<{ accounts: QuickLoginAccount[]; onClose: () => void }> = ({ accounts, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const { user } = useAuth();
  const { switchTo, busy, error } = useDevSwitchAccount();
  useDialogFocus(ref, true, onClose);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-4 ui-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="dev-switch-title" className="glass-modal w-full max-w-xl max-h-[90vh] overflow-y-auto p-4 sm:p-5 space-y-3" data-testid="dev-switch-dialog">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="dev-switch-title" className="text-base font-bold text-ui-ink">Switch account <span className="text-ui-muted font-semibold">(dev)</span></h2>
            <p className="text-xs text-ui-muted">Signs out, signs in as the account you pick, and opens its home page.</p>
          </div>
          <button type="button" onClick={onClose} className="ui-icon-btn h-11 w-11 shrink-0" aria-label="Close">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        {error && <p role="alert" className="p-3 rounded-xl status-tint status-changes text-xs font-semibold">{error}</p>}
        <QuickLoginGroups accounts={accounts} busy={busy} currentEmail={user?.email} onPick={(a) => void switchTo(a)} />
      </div>
    </div>
  );
};
