import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiFetch, ApiError } from '../lib/api';
import { SELECTABLE_DEPARTMENTS, JOB_ROLES, requestAccessSchema, type RequestableRole, WORKER_ROLE, REQUESTABLE_ROLES, ROLE_LABELS } from '@mmp/shared';
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff, ShieldAlert, Sparkles } from 'lucide-react';
import { homePathFor } from '../lib/access';
import { AuthShell } from '../components/auth/AuthShell';

type View = 'signin' | 'request' | 'forgot';

/** Small label above a field, tied to it by id. */
const FieldLabel: React.FC<{ htmlFor: string; children: React.ReactNode; aside?: React.ReactNode }> = ({ htmlFor, children, aside }) => (
  <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
    <label htmlFor={htmlFor} className="text-[12px] font-semibold text-ui-text">
      {children}
    </label>
    {aside}
  </div>
);

const FieldError: React.FC<{ id: string; message?: string }> = ({ id, message }) =>
  message ? (
    <p id={id} className="mt-1 px-1 text-[11px] font-medium text-rose-700">
      {message}
    </p>
  ) : null;

const Notice: React.FC<{ tone: 'error' | 'warn' | 'success'; title?: string; children: React.ReactNode }> = ({ tone, title, children }) => {
  const styles = {
    error: 'border-rose-200 bg-rose-50/90 text-rose-800',
    warn: 'border-amber-200 bg-amber-50/90 text-amber-800',
    success: 'border-emerald-200 bg-emerald-50/90 text-emerald-800',
  }[tone];
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'warn' ? ShieldAlert : AlertCircle;
  return (
    <div role={tone === 'success' ? 'status' : 'alert'} className={`flex items-start gap-3 rounded-2xl border p-3.5 text-[12px] leading-relaxed ${styles}`}>
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <div>
        {title && <span className="mb-0.5 block font-bold">{title}</span>}
        {children}
      </div>
    </div>
  );
};

const linkClass =
  'font-semibold text-ui-ink underline decoration-ui-coral decoration-2 underline-offset-4 hover:decoration-ui-ink';
const headingClass = 'text-[30px] font-semibold leading-[1.1] tracking-tight text-ui-ink sm:text-[34px]';
const subheadingClass = 'mt-2 text-[14px] text-ui-muted';

export const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Which panel the card shows: sign in, request access or reset password.
  const [view, setView] = useState<View>('signin');

  // Login form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<{ code?: string; message: string } | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  // Pre-fill email and notice if navigated from SetPasswordPage
  useEffect(() => {
    const state = location.state as { email?: string; passwordSet?: boolean } | null;
    if (state?.email) {
      setEmail(state.email);
    }
    if (state?.passwordSet) {
      setSuccessNotice('Password updated. Sign in with your new password.');
    }
  }, [location.state]);

  // Request access state
  const [reqName, setReqName] = useState('');
  const [reqEmail, setReqEmail] = useState('');
  const [reqPhone, setReqPhone] = useState('');
  const [reqDept, setReqDept] = useState<string>(SELECTABLE_DEPARTMENTS[0].name);
  const [reqJobRole, setReqJobRole] = useState<string>(JOB_ROLES[0]);
  const [reqRole, setReqRole] = useState<RequestableRole>(WORKER_ROLE);
  const [reqReason, setReqReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSubmittingReq, setIsSubmittingReq] = useState(false);
  const [reqSuccess, setReqSuccess] = useState<string | null>(null);
  const [reqError, setReqError] = useState<string | null>(null);

  // Forgot password state
  const [forgotEmail, setForgotEmail] = useState('');
  const [isSubmittingForgot, setIsSubmittingForgot] = useState(false);
  const [forgotSuccess, setForgotSuccess] = useState<string | null>(null);
  const [forgotResetLink, setForgotResetLink] = useState<string | null>(null);
  const [forgotError, setForgotError] = useState<string | null>(null);

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmittingForgot(true);
    setForgotError(null);
    setForgotSuccess(null);
    setForgotResetLink(null);

    try {
      const cleanForgotEmail = forgotEmail.trim().toLowerCase();
      const res = await apiFetch<{ message?: string; resetLink?: string }>('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: cleanForgotEmail }),
      });
      setForgotSuccess(res.message || 'If an active account exists with this email address, a password reset link has been dispatched.');
      if (res.resetLink) {
        setForgotResetLink(res.resetLink);
      }
    } catch (err: any) {
      setForgotError(err.message || 'Failed to submit reset request. Please check email address.');
    } finally {
      setIsSubmittingForgot(false);
    }
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    return signIn(email, password);
  };

  const signIn = async (signInEmail: string, signInPassword: string) => {
    setIsLoggingIn(true);
    setLoginError(null);
    setSuccessNotice(null);

    const cleanEmail = signInEmail.trim().toLowerCase();

    try {
      // Spaces at either end are never part of a password (often pasted with a temporary one).
      const loggedUser = await login({ email: cleanEmail, password: signInPassword.trim() });
      if (loggedUser.mustChangePassword) {
        navigate('/settings?tab=security', { replace: true });
        return;
      }
      navigate(homePathFor(loggedUser));
    } catch (err: any) {
      if (err instanceof ApiError) {
        setLoginError({ code: err.code, message: err.message });
      } else {
        setLoginError({ message: err.message || 'Login failed. Please check credentials.' });
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleRequestAccess = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmittingReq(true);
    setReqError(null);
    setReqSuccess(null);
    setFieldErrors({});

    const validation = requestAccessSchema.safeParse({
      name: reqName,
      email: reqEmail,
      phone: reqPhone,
      department: reqDept,
      jobRole: reqJobRole,
      requestedRole: reqRole,
      reason: reqReason,
    });

    if (!validation.success) {
      const errors: Record<string, string> = {};
      validation.error.issues.forEach((issue) => {
        const fieldName = issue.path[0] as string;
        if (fieldName && !errors[fieldName]) {
          errors[fieldName] = issue.message;
        }
      });
      setFieldErrors(errors);
      setReqError(validation.error.issues[0]?.message || 'Please check the required fields.');
      setIsSubmittingReq(false);
      return;
    }

    try {
      const res = await apiFetch<{ message?: string }>('/auth/request-access', {
        method: 'POST',
        body: JSON.stringify(validation.data),
      });

      setReqSuccess(res.message || 'Request sent. You will get an email when it is reviewed.');
      setReqName('');
      setReqEmail('');
      setReqPhone('');
      setReqReason('');
      setFieldErrors({});
    } catch (err: any) {
      if (
        err?.code === 'DUPLICATE_PENDING_REQUEST' ||
        (err?.message && err.message.toLowerCase().includes('already pending'))
      ) {
        setReqError('A request for this email is already pending.');
      } else if (
        err?.code === 'USER_EXISTS' ||
        (err?.message && err.message.toLowerCase().includes('already exists'))
      ) {
        setReqError('An account already exists with this email address. Please log in.');
      } else {
        setReqError(err?.message || 'Failed to submit request. Please try again.');
      }
    } finally {
      setIsSubmittingReq(false);
    }
  };

  const openRequest = () => {
    setReqSuccess(null);
    setReqError(null);
    setFieldErrors({});
    setView('request');
  };
  const openForgot = () => {
    setForgotEmail(email);
    setForgotSuccess(null);
    setForgotResetLink(null);
    setForgotError(null);
    setView('forgot');
  };
  const backToSignIn = () => setView('signin');

  const inputClass = (field: string) => `ui-input w-full ${fieldErrors[field] ? '!border-rose-400' : ''}`;
  const describedBy = (field: string) => (fieldErrors[field] ? `req-${field}-error` : undefined);

  const backLink = (
    <button
      type="button"
      onClick={backToSignIn}
      className="-ml-2 mb-2 inline-flex min-h-[40px] items-center gap-1.5 self-start rounded-full px-2 text-[12px] font-semibold text-ui-muted hover:text-ui-ink"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Back to sign in
    </button>
  );

  return (
    <AuthShell>
      <div key={view} className="auth-view-enter flex flex-1 flex-col">
      {view === 'signin' && (
        <>
          <h1 className={headingClass}>Welcome back</h1>
          <p className={subheadingClass}>Sign in with your work email to open your dashboard.</p>

          {(successNotice || loginError) && (
            <div className="mt-6 space-y-3">
              {successNotice && <Notice tone="success">{successNotice}</Notice>}
              {loginError && (
                <Notice
                  tone={loginError.code?.startsWith('ACCESS_REQUEST') ? 'warn' : 'error'}
                  title={
                    loginError.code === 'ACCESS_REQUEST_PENDING'
                      ? 'Pending approval'
                      : loginError.code === 'ACCESS_REQUEST_REJECTED'
                      ? 'Access rejected'
                      : loginError.code === 'ACCOUNT_SUSPENDED'
                      ? 'Account suspended'
                      : "Couldn't sign in"
                  }
                >
                  {loginError.message}
                </Notice>
              )}
            </div>
          )}

          <form onSubmit={handleLogin} className="mt-6 space-y-4">
            <div>
              <FieldLabel htmlFor="login-email">Email</FieldLabel>
              <input
                id="login-email"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                className="ui-input w-full"
              />
            </div>

            <div>
              <FieldLabel
                htmlFor="login-password"
                aside={
                  <button type="button" onClick={openForgot} className={`text-[12px] ${linkClass}`}>
                    Forgot password?
                  </button>
                }
              >
                Password
              </FieldLabel>
              <div className="relative">
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  // Pasted passwords (e.g. a temporary one from WhatsApp) often carry a space at either end.
                  onPaste={(e) => {
                    const pasted = e.clipboardData.getData('text');
                    if (pasted !== pasted.trim()) {
                      e.preventDefault();
                      const el = e.currentTarget;
                      const start = el.selectionStart ?? password.length;
                      const end = el.selectionEnd ?? password.length;
                      setPassword((password.slice(0, start) + pasted.trim() + password.slice(end)).trim());
                    }
                  }}
                  onBlur={() => {
                    setPassword((p) => p.trim());
                    setCapsLock(false);
                  }}
                  placeholder="••••••••"
                  aria-describedby={capsLock ? 'login-caps' : undefined}
                  onKeyUp={(e) => setCapsLock(e.getModifierState('CapsLock'))}
                  onKeyDown={(e) => setCapsLock(e.getModifierState('CapsLock'))}
                  className="ui-input w-full pr-12"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-ui-muted hover:text-ui-ink"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                </button>
              </div>
              {capsLock && (
                <p id="login-caps" className="mt-1.5 px-1 text-[11px] font-medium text-amber-700">
                  Caps Lock is on.
                </p>
              )}
            </div>

            <button type="submit" disabled={isLoggingIn} className="ui-btn ui-btn-primary mt-2 h-12 w-full text-[13px]">
              {isLoggingIn ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
                  <span>Signing in…</span>
                </>
              ) : (
                <>
                  <span>Sign in</span>
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </>
              )}
            </button>
          </form>

          <p className="mt-auto pt-10 text-center text-[12px] text-ui-muted">
            Don't have an account?{' '}
            <button type="button" onClick={openRequest} className={linkClass}>
              Request access
            </button>
          </p>
        </>
      )}

      {view === 'request' && (
        <>
          {backLink}
          {reqSuccess ? (
            <div className="my-auto space-y-4 py-8 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-emerald-600">
                <CheckCircle2 className="h-7 w-7" aria-hidden="true" />
              </div>
              <h1 className={headingClass}>Request sent</h1>
              <p role="status" className="mx-auto max-w-sm text-[13px] leading-relaxed text-ui-muted">
                You'll get an email when an administrator has reviewed it.
              </p>
              <button type="button" onClick={backToSignIn} className="ui-btn ui-btn-primary mt-2 h-11">
                Back to sign in
              </button>
            </div>
          ) : (
            <>
              <h1 className="text-[28px] font-semibold leading-[1.1] tracking-tight text-ui-ink sm:text-[30px]">Request access</h1>
              <p className="mt-2 text-[14px] text-ui-muted">
                Tell us who you are. An administrator reviews your request and confirms your role.
              </p>

              <form onSubmit={handleRequestAccess} noValidate className="auth-compact mt-6 space-y-4">
                {reqError && <Notice tone="error">{reqError}</Notice>}

                <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                  <div>
                    <FieldLabel htmlFor="req-name">Full name</FieldLabel>
                    <input
                      id="req-name"
                      type="text"
                      required
                      autoComplete="name"
                      value={reqName}
                      onChange={(e) => setReqName(e.target.value)}
                      placeholder="Jane Doe"
                      aria-invalid={!!fieldErrors.name}
                      aria-describedby={describedBy('name')}
                      className={inputClass('name')}
                    />
                    <FieldError id="req-name-error" message={fieldErrors.name} />
                  </div>
                  <div>
                    <FieldLabel htmlFor="req-email">Work email</FieldLabel>
                    <input
                      id="req-email"
                      type="email"
                      required
                      autoComplete="email"
                      value={reqEmail}
                      onChange={(e) => setReqEmail(e.target.value)}
                      placeholder="jane@company.com"
                      aria-invalid={!!fieldErrors.email}
                      aria-describedby={describedBy('email')}
                      className={inputClass('email')}
                    />
                    <FieldError id="req-email-error" message={fieldErrors.email} />
                  </div>
                  <div>
                    <FieldLabel htmlFor="req-phone">Phone number</FieldLabel>
                    <input
                      id="req-phone"
                      type="tel"
                      required
                      autoComplete="tel"
                      value={reqPhone}
                      onChange={(e) => setReqPhone(e.target.value)}
                      placeholder="+91 98765 43210"
                      aria-invalid={!!fieldErrors.phone}
                      aria-describedby={describedBy('phone')}
                      className={inputClass('phone')}
                    />
                    <FieldError id="req-phone-error" message={fieldErrors.phone} />
                  </div>
                  <div>
                    <FieldLabel htmlFor="req-dept">Department</FieldLabel>
                    <select
                      id="req-dept"
                      value={reqDept}
                      onChange={(e) => setReqDept(e.target.value)}
                      aria-describedby={describedBy('department')}
                      className="ui-select w-full"
                    >
                      {SELECTABLE_DEPARTMENTS.map((dept) => (
                        <option key={dept.code} value={dept.name}>
                          {dept.name}
                        </option>
                      ))}
                    </select>
                    <FieldError id="req-department-error" message={fieldErrors.department} />
                  </div>
                  <div>
                    <FieldLabel htmlFor="req-job">Job role</FieldLabel>
                    <select
                      id="req-job"
                      value={reqJobRole}
                      onChange={(e) => setReqJobRole(e.target.value)}
                      aria-describedby={describedBy('jobRole')}
                      className="ui-select w-full"
                    >
                      {JOB_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                    <FieldError id="req-jobRole-error" message={fieldErrors.jobRole} />
                  </div>
                  <div>
                    <FieldLabel htmlFor="req-role">Requested role</FieldLabel>
                    <select
                      id="req-role"
                      value={reqRole}
                      onChange={(e) => setReqRole(e.target.value as RequestableRole)}
                      aria-describedby={describedBy('requestedRole')}
                      className="ui-select w-full"
                    >
                      {REQUESTABLE_ROLES.map((rk) => (
                        <option key={rk} value={rk}>
                          {ROLE_LABELS[rk]}
                        </option>
                      ))}
                    </select>
                    <FieldError id="req-requestedRole-error" message={fieldErrors.requestedRole} />
                  </div>
                </div>

                <div>
                  <FieldLabel htmlFor="req-reason">Reason for access</FieldLabel>
                  <textarea
                    id="req-reason"
                    required
                    rows={2}
                    value={reqReason}
                    onChange={(e) => setReqReason(e.target.value)}
                    placeholder="Briefly describe your role and the work you'll do in the marketing team."
                    aria-invalid={!!fieldErrors.reason}
                    aria-describedby={describedBy('reason')}
                    className={`${inputClass('reason')} ui-textarea resize-none`}
                  />
                  <FieldError id="req-reason-error" message={fieldErrors.reason} />
                </div>

                <button type="submit" disabled={isSubmittingReq} className="ui-btn ui-btn-primary !mt-5 h-12 w-full text-[13px]">
                  {isSubmittingReq ? (
                    'Sending request…'
                  ) : (
                    <>
                      Send request
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </>
                  )}
                </button>
              </form>
            </>
          )}
        </>
      )}

      {view === 'forgot' && (
        <>
          {backLink}
          <h1 className={headingClass}>Reset password</h1>
          <p className={subheadingClass}>We'll email you a link to set a new password.</p>

          {forgotSuccess ? (
            <div className="mt-6 space-y-4">
              <Notice tone="success">{forgotSuccess}</Notice>
              {forgotResetLink && (
                <div className="space-y-2 rounded-2xl border border-ui-line bg-ui-card p-4 text-[12px] text-ui-text">
                  <div className="flex items-center gap-1.5 font-bold text-ui-ink">
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                    <span>Development link</span>
                  </div>
                  <p className="leading-relaxed text-ui-muted">Email is in console mode locally, so you can open the link directly:</p>
                  <Link to={forgotResetLink.replace(/^https?:\/\/[^/]+/, '')} className="ui-btn ui-btn-primary h-10">
                    Set new password
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </div>
              )}
              <button type="button" onClick={backToSignIn} className="ui-btn ui-btn-secondary h-11 w-full">
                Back to sign in
              </button>
            </div>
          ) : (
            <form onSubmit={handleForgotPassword} className="mt-6 space-y-4">
              {forgotError && <Notice tone="error">{forgotError}</Notice>}
              <div>
                <FieldLabel htmlFor="forgot-email">Account email</FieldLabel>
                <input
                  id="forgot-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  placeholder="name@company.com"
                  className="ui-input w-full"
                />
              </div>
              <button type="submit" disabled={isSubmittingForgot || !forgotEmail.trim()} className="ui-btn ui-btn-primary h-12 w-full text-[13px]">
                {isSubmittingForgot ? 'Sending link…' : 'Send reset link'}
              </button>
            </form>
          )}
        </>
      )}
      </div>
    </AuthShell>
  );
};
