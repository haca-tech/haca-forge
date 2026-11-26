import React, { useEffect, useRef, useState } from 'react';
import { ROLE_KEYS, ROLE_LABELS } from '@mmp/shared';
import { Check, Copy } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useDialogFocus } from '../../lib/useDialogFocus';

type Action = 'role' | 'reset' | 'regenerate' | 'logout';

interface AdminAccountActionsProps {
  person: { _id: string; name: string; role: string; email?: string; status?: string };
  /** Called after a successful action with a message for the page to announce. */
  onDone: (message: string, action: Action) => void;
}

const roleName = (role: string) => ROLE_LABELS[role as keyof typeof ROLE_LABELS] || role;

/** Modal shell shared by the three account actions. Mounted only while open. */
const ActionDialog: React.FC<{
  titleId: string;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ titleId, title, onClose, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, true, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 ui-scrim">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="glass-modal w-full max-w-md max-h-[92vh] overflow-y-auto p-6 space-y-4"
      >
        <h3 id={titleId} className="text-base font-bold text-ui-ink">
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
};

const ErrorNotice: React.FC<{ message: string | null }> = ({ message }) =>
  message ? (
    <p role="alert" className="status-tint status-changes rounded-ui-control px-3 py-2 text-[13px] font-medium">
      {message}
    </p>
  ) : null;

/**
 * Admin-only account controls for another person's profile: change role, reset password,
 * regenerate password (shows a one-time temporary password), force logout. Each one asks for confirmation before it calls the API. The parent decides
 * who sees this (admin, viewing someone else).
 */
export const AdminAccountActions: React.FC<AdminAccountActionsProps> = ({ person, onDone }) => {
  const [open, setOpen] = useState<Action | null>(null);
  const [step, setStep] = useState<'choose' | 'confirm'>('choose');
  const [newRole, setNewRole] = useState(person.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Switching between the two role steps replaces the focused button, so move focus
  // into the new step instead of letting it fall back to the page.
  const confirmStepRef = useRef<HTMLDivElement>(null);
  const roleSelectRef = useRef<HTMLSelectElement>(null);
  const stepChanged = useRef(false);
  useEffect(() => {
    if (open !== 'role' || !stepChanged.current) return;
    stepChanged.current = false;
    if (step === 'confirm') confirmStepRef.current?.focus();
    else roleSelectRef.current?.focus();
  }, [open, step]);
  const goToStep = (next: 'choose' | 'confirm') => {
    stepChanged.current = true;
    setError(null);
    setStep(next);
  };

  // Role changes are recorded in the access History with a reason (the API requires one).
  const [reason, setReason] = useState('');
  // Regenerate password: the temporary password lives only in this state while the dialog is open.
  const [regenerated, setRegenerated] = useState<{ email: string; status?: string; temporaryPassword: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const passwordRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (regenerated) passwordRef.current?.focus();
  }, [regenerated]);
  const copyPassword = async () => {
    if (!regenerated) return;
    try {
      await navigator.clipboard.writeText(regenerated.temporaryPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copy failed. Select the password and copy it by hand.');
    }
  };
  const finishRegenerate = () => {
    setRegenerated(null);
    setCopied(false);
    setOpen(null);
    onDone(
      `New temporary password created for ${person.name}. They must change it after signing in.`,
      'regenerate'
    );
  };
  const openAction = (action: Action) => {
    setError(null);
    setRegenerated(null);
    setCopied(false);
    setBusy(false);
    setStep('choose');
    setNewRole(person.role);
    setReason('');
    setOpen(action);
  };
  const close = () => {
    if (busy) return;
    if (regenerated) {
      finishRegenerate();
      return;
    }
    setOpen(null);
  };

  const run = async (action: Action) => {
    // Confirm buttons use aria-disabled (a disabled button would drop keyboard focus), so guard here.
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (action === 'role') {
        if (reason.trim().length < 3) {
          setBusy(false);
          setError('Give a reason for this change.');
          return;
        }
        await apiFetch(`/api/team/${person._id}`, { method: 'PATCH', body: JSON.stringify({ role: newRole, reason: reason.trim() }) });
        onDone(`${person.name}'s role is now ${roleName(newRole)}.`, action);
      } else if (action === 'reset') {
        await apiFetch(`/api/team/${person._id}/reset-password`, { method: 'POST' });
        onDone(
          `Password reset for ${person.name}. They must set a new password with "Forgot password?" on the sign-in page before they can sign in.`,
          action
        );
      } else if (action === 'regenerate') {
        const res = await apiFetch<any>(`/api/team/${person._id}/regenerate-password`, { method: 'POST' });
        const data = res?.data ?? res;
        if (!data?.temporaryPassword) throw new Error('The server did not return a password. Try again.');
        setRegenerated({ email: data.email, status: data.status, temporaryPassword: data.temporaryPassword });
        setBusy(false);
        return; // Keep the dialog open to show the password; onDone runs when the admin closes it.
      } else {
        await apiFetch(`/api/team/${person._id}/force-logout`, { method: 'POST' });
        onDone(`${person.name} has been signed out of all devices.`, action);
      }
      setBusy(false);
      setOpen(null);
    } catch (err: any) {
      setBusy(false);
      setError(err?.message || 'The request failed. Nothing was changed.');
    }
  };

  return (
    <>
      <button type="button" onClick={() => openAction('role')} className="ui-btn ui-btn-secondary h-11">
        Change role
      </button>
      <button type="button" onClick={() => openAction('reset')} className="ui-btn ui-btn-secondary h-11">
        Reset password
      </button>
      <button type="button" onClick={() => openAction('regenerate')} className="ui-btn ui-btn-secondary h-11">
        Regenerate password
      </button>
      <button type="button" onClick={() => openAction('logout')} className="ui-btn ui-btn-secondary h-11">
        Force logout
      </button>

      {open === 'role' && (
        <ActionDialog titleId="admin-role-title" title={`Change role: ${person.name}`} onClose={close}>
          {step === 'choose' ? (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (newRole !== person.role) goToStep('confirm');
              }}
            >
              <p className="text-[13px] text-ui-muted">
                Current role: <span className="font-semibold text-ui-ink">{roleName(person.role)}</span>
              </p>
              <div className="space-y-1.5">
                <label htmlFor="admin-role-select" className="text-[13px] font-medium text-ui-muted block">
                  New role
                </label>
                <select
                  ref={roleSelectRef}
                  id="admin-role-select"
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value)}
                  className="ui-select w-full"
                >
                  {ROLE_KEYS.map((rk) => (
                    <option key={rk} value={rk}>
                      {roleName(rk)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                <button type="button" onClick={close} className="ui-btn ui-btn-secondary h-11">
                  Cancel
                </button>
                <button type="submit" disabled={newRole === person.role} className="ui-btn ui-btn-primary h-11">
                  Review change
                </button>
              </div>
            </form>
          ) : (
            <div
              ref={confirmStepRef}
              tabIndex={-1}
              aria-label="Confirm the role change"
              className="space-y-4 rounded-ui-control focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-ink"
            >
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                <dt className="text-ui-muted">Current role</dt>
                <dd className="font-semibold text-ui-ink">{roleName(person.role)}</dd>
                <dt className="text-ui-muted">New role</dt>
                <dd className="font-semibold text-ui-ink">{roleName(newRole)}</dd>
              </dl>
              <p className="text-[13px] text-ui-text">
                Their permissions change straight away, including which pages and data they can open.
              </p>
              <div className="space-y-1.5">
                <label htmlFor="admin-role-reason" className="text-[13px] font-medium text-ui-muted block">
                  Reason (kept in the access History)
                </label>
                <input
                  id="admin-role-reason"
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="ui-input w-full h-11"
                  placeholder="For example: moved to the Ads team"
                />
              </div>
              <ErrorNotice message={error} />
              <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                <button type="button" onClick={() => goToStep('choose')} disabled={busy} className="ui-btn ui-btn-secondary h-11">
                  Back
                </button>
                <button type="button" onClick={() => run('role')} aria-disabled={busy} className="ui-btn ui-btn-primary h-11 aria-disabled:opacity-60 aria-disabled:cursor-wait">
                  {busy ? 'Saving…' : 'Confirm role change'}
                </button>
              </div>
            </div>
          )}
        </ActionDialog>
      )}

      {open === 'reset' && (
        <ActionDialog titleId="admin-reset-title" title={`Reset password for ${person.name}?`} onClose={close}>
          <ul className="list-disc pl-5 space-y-1.5 text-[13px] text-ui-text">
            <li>They can't sign in until they set a new password.</li>
            <li>
              No email is sent by this action. They set a new password with "Forgot password?" on the sign-in
              page, which emails a link to their registered email.
            </li>
            <li>Devices they're already signed in on stay signed in. Use Force logout to end those sessions.</li>
          </ul>
          <ErrorNotice message={error} />
          <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
            <button type="button" onClick={close} disabled={busy} className="ui-btn ui-btn-secondary h-11">
              Cancel
            </button>
            <button type="button" onClick={() => run('reset')} aria-disabled={busy} className="ui-btn ui-btn-primary h-11 aria-disabled:opacity-60 aria-disabled:cursor-wait">
              {busy ? 'Resetting…' : 'Reset password'}
            </button>
          </div>
        </ActionDialog>
      )}

      {open === 'regenerate' && (
        <ActionDialog
          titleId="admin-regenerate-title"
          title={regenerated ? `New password for ${person.name}` : `Regenerate password for ${person.name}?`}
          onClose={close}
        >
          {!regenerated ? (
            <>
              <ul className="list-disc pl-5 space-y-1.5 text-[13px] text-ui-text">
                <li>Their current password stops working straight away.</li>
                <li>You'll see a new temporary password once. Share it with them directly, for example in person or on a call.</li>
                <li>They must choose a new password as soon as they sign in with it.</li>
                <li>They're signed out of every device.</li>
              </ul>
              <ErrorNotice message={error} />
              <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                <button type="button" onClick={close} disabled={busy} className="ui-btn ui-btn-secondary h-11">
                  Cancel
                </button>
                <button type="button" onClick={() => run('regenerate')} aria-disabled={busy} className="ui-btn ui-btn-primary h-11 aria-disabled:opacity-60 aria-disabled:cursor-wait">
                  {busy ? 'Generating…' : 'Regenerate password'}
                </button>
              </div>
            </>
          ) : (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
                <dt className="text-ui-muted">Email</dt>
                <dd className="font-semibold text-ui-ink break-all">{regenerated.email}</dd>
                <dt className="text-ui-muted self-center">Temporary password</dt>
                <dd className="flex items-center gap-2">
                  <code
                    ref={passwordRef}
                    tabIndex={-1}
                    aria-label="Temporary password"
                    className="rounded-ui-control bg-ui-canvas px-2.5 py-1.5 font-mono text-[15px] font-semibold tracking-wide text-ui-ink select-all focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-ink"
                  >
                    {regenerated.temporaryPassword}
                  </code>
                  <button type="button" onClick={copyPassword} className="ui-btn ui-btn-secondary h-9 px-2.5" aria-label={copied ? 'Password copied' : 'Copy password'}>
                    {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                  </button>
                </dd>
              </dl>
              <p className="text-[13px] text-ui-text">
                This is the only time it's shown. Copy it now. If it's lost, regenerate a new one.
              </p>
              {regenerated.status === 'suspended' && (
                <p className="status-tint status-changes rounded-ui-control px-3 py-2 text-[13px] font-medium">
                  This account is suspended, so they still can't sign in until you reactivate it.
                </p>
              )}
              <ErrorNotice message={error} />
              <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
                <button type="button" onClick={finishRegenerate} className="ui-btn ui-btn-primary h-11">
                  Done
                </button>
              </div>
            </>
          )}
        </ActionDialog>
      )}

      {open === 'logout' && (
        <ActionDialog titleId="admin-logout-title" title={`Sign ${person.name} out everywhere?`} onClose={close}>
          <p className="text-[13px] text-ui-text">
            This ends all of their sessions, so they'll need to sign in again. A page they already have open can
            keep working for a few minutes until its access expires.
          </p>
          <ErrorNotice message={error} />
          <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
            <button type="button" onClick={close} disabled={busy} className="ui-btn ui-btn-secondary h-11">
              Cancel
            </button>
            <button type="button" onClick={() => run('logout')} aria-disabled={busy} className="ui-btn ui-btn-primary h-11 aria-disabled:opacity-60 aria-disabled:cursor-wait">
              {busy ? 'Signing out…' : 'Force logout'}
            </button>
          </div>
        </ActionDialog>
      )}
    </>
  );
};
