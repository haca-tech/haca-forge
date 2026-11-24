import React, { useRef, useState } from 'react';
import { ROLE_KEYS, ROLE_LABELS, JOB_ROLES, WORKER_ROLE } from '@mmp/shared';
import { Eye, EyeOff, Sparkles, Copy, Check } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useDialogFocus } from '../../lib/useDialogFocus';

interface InviteUserDialogProps {
  onClose: () => void;
  /** Called after the account is created, with a message for the page to announce. */
  onInvited: (message: string) => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateSecureTemporaryPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const specials = '!@#$%^&*';
  const all = upper + lower + digits + specials;

  const chars = [
    upper[Math.floor(Math.random() * upper.length)],
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    lower[Math.floor(Math.random() * lower.length)],
    digits[Math.floor(Math.random() * digits.length)],
    digits[Math.floor(Math.random() * digits.length)],
    specials[Math.floor(Math.random() * specials.length)],
    specials[Math.floor(Math.random() * specials.length)],
  ];
  while (chars.length < 12) {
    chars.push(all[Math.floor(Math.random() * all.length)]);
  }
  return chars.sort(() => Math.random() - 0.5).join('');
}

/**
 * Admin-only "Invite user" dialog for /team. Creates the account through POST /api/people.
 * Supports specifying or generating a temporary password requiring password change on first sign-in.
 */
export const InviteUserDialog: React.FC<InviteUserDialogProps> = ({ onClose, onInvited }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState({
    name: '',
    email: '',
    role: WORKER_ROLE as string,
    jobRole: '',
    temporaryPassword: '',
    confirmTemporaryPassword: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (!busy) onClose();
  };
  useDialogFocus(dialogRef, true, close);

  const handleGeneratePassword = () => {
    const generated = generateSecureTemporaryPassword();
    setForm((prev) => ({
      ...prev,
      temporaryPassword: generated,
      confirmTemporaryPassword: generated,
    }));
    setShowPassword(true);
    setError(null);
  };

  const handleCopyPassword = async () => {
    if (!form.temporaryPassword) return;
    try {
      await navigator.clipboard.writeText(form.temporaryPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard write failures
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const name = form.name.trim();
    const email = form.email.trim().toLowerCase();
    if (!name) return setError('Enter their full name.');
    if (!EMAIL_PATTERN.test(email)) return setError('Enter a valid email address.');

    const tempPassword = form.temporaryPassword;
    const confirmPassword = form.confirmTemporaryPassword;

    if (tempPassword) {
      if (tempPassword.length < 8) {
        return setError('Temporary password must be at least 8 characters long.');
      }
      if (!/[A-Z]/.test(tempPassword)) {
        return setError('Temporary password must contain at least one uppercase letter.');
      }
      if (!/[0-9]/.test(tempPassword)) {
        return setError('Temporary password must contain at least one number.');
      }
      if (tempPassword !== confirmPassword) {
        return setError('Temporary password and confirmation do not match.');
      }
    }

    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, any> = {
        name,
        email,
        role: form.role,
        ...(form.jobRole ? { jobRole: form.jobRole } : {}),
      };

      if (tempPassword) {
        payload.temporaryPassword = tempPassword;
        payload.confirmTemporaryPassword = confirmPassword;
      }

      await apiFetch('/api/people', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setBusy(false);

      if (tempPassword) {
        onInvited(
          `Account created for ${name} with a temporary password. Ask them to sign in using ${email} and set a new password.`
        );
      } else {
        onInvited(
          `Account created for ${name}. Ask them to set a password with "Forgot password?" on the sign-in page, using ${email}.`
        );
      }
    } catch (err: any) {
      setBusy(false);
      setError(err?.message || 'The account could not be created. Nothing was saved.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 ui-scrim">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-user-title"
        aria-describedby="invite-user-desc"
        className="glass-modal w-full max-w-md max-h-[92vh] overflow-y-auto p-6 space-y-4"
      >
        <h3 id="invite-user-title" className="text-base font-bold text-ui-ink">
          Invite user
        </h3>
        <p id="invite-user-desc" className="text-[13px] text-ui-muted">
          Create their account. You can specify or generate a temporary password that they must change upon first sign-in, or let them set their password via "Forgot password?".
        </p>

        <form onSubmit={submit} noValidate className="space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="invite-name" className="text-[13px] font-medium text-ui-muted block">
              Full name
            </label>
            <input
              id="invite-name"
              type="text"
              autoComplete="off"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="ui-input w-full"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="invite-email" className="text-[13px] font-medium text-ui-muted block">
              Registered email
            </label>
            <input
              id="invite-email"
              type="email"
              autoComplete="off"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="ui-input w-full"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="invite-role" className="text-[13px] font-medium text-ui-muted block">
              Role
            </label>
            <select
              id="invite-role"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="ui-select w-full"
            >
              {ROLE_KEYS.map((rk) => (
                <option key={rk} value={rk}>
                  {ROLE_LABELS[rk]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="invite-job-role" className="text-[13px] font-medium text-ui-muted block">
              Job role (optional)
            </label>
            <select
              id="invite-job-role"
              value={form.jobRole}
              onChange={(e) => setForm({ ...form, jobRole: e.target.value })}
              className="ui-select w-full"
            >
              <option value="">None</option>
              {JOB_ROLES.map((jr) => (
                <option key={jr} value={jr}>
                  {jr}
                </option>
              ))}
            </select>
          </div>

          {/* Temporary Password Section */}
          <div className="pt-2 border-t border-ui-line space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-bold text-ui-ink">Temporary Password</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleGeneratePassword}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-ui-ink bg-ui-ink/5 hover:bg-ui-ink/10 rounded-lg transition-colors"
                  title="Generate secure temporary password"
                >
                  <Sparkles className="w-3.5 h-3.5 text-amber-600" />
                  <span>Generate</span>
                </button>
                {form.temporaryPassword && (
                  <button
                    type="button"
                    onClick={handleCopyPassword}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-ui-muted hover:text-ui-ink transition-colors"
                    title="Copy password to clipboard"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="p-1 text-ui-muted hover:text-ui-ink transition-colors rounded"
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="invite-temporary-password" className="text-[12px] font-medium text-ui-muted block">
                Temporary Password (optional)
              </label>
              <div className="relative">
                <input
                  id="invite-temporary-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder="Leave empty or set a temporary password"
                  value={form.temporaryPassword}
                  onChange={(e) => setForm({ ...form, temporaryPassword: e.target.value })}
                  className="ui-input w-full pr-10 text-[13px]"
                />
              </div>
            </div>

            {form.temporaryPassword && (
              <div className="space-y-1.5">
                <label htmlFor="invite-confirm-temporary-password" className="text-[12px] font-medium text-ui-muted block">
                  Confirm Temporary Password
                </label>
                <input
                  id="invite-confirm-temporary-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder="Re-enter temporary password"
                  value={form.confirmTemporaryPassword}
                  onChange={(e) => setForm({ ...form, confirmTemporaryPassword: e.target.value })}
                  className="ui-input w-full text-[13px]"
                />
              </div>
            )}
          </div>

          {error && (
            <p role="alert" className="status-tint status-changes rounded-ui-control px-3 py-2 text-[13px] font-medium">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
            <button type="button" onClick={close} disabled={busy} className="ui-btn ui-btn-secondary h-11">
              Cancel
            </button>
            <button type="submit" aria-disabled={busy} className="ui-btn ui-btn-primary h-11 aria-disabled:opacity-60 aria-disabled:cursor-wait">
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
