import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useDialogFocus } from './useDialogFocus';

/**
 * The app's replacement for the browser's alert, confirm and prompt (a guard test keeps those out):
 * - toast.error / toast.success / toast.info: a short message in the corner, gone after a few seconds;
 * - confirmDialog({...}): resolves true on confirm, false on cancel or Esc;
 * - promptDialog({...}): resolves the trimmed text, or null on cancel.
 * They work from any event handler. <UiFeedbackHost /> renders them; App mounts it, and the first
 * call mounts one itself when there is none (a component rendered on its own, e.g. in a test).
 */

type Tone = 'error' | 'success' | 'info';
interface ToastItem { id: number; tone: Tone; message: string }

export interface ConfirmOptions {
  title: string;
  /** What will happen, naming the item. */
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Deletes or removes something: the confirm button is red. */
  danger?: boolean;
}
export interface PromptOptions {
  title: string;
  label: string;
  message?: React.ReactNode;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  /** Default true: an empty answer is refused. */
  required?: boolean;
  maxLength?: number;
  multiline?: boolean;
  inputType?: 'text' | 'url';
  /** Returns an error message, or null when the value is fine. */
  validate?: (value: string) => string | null;
}

type DialogRequest =
  | { id: number; kind: 'confirm'; options: ConfirmOptions; resolve: (v: boolean) => void }
  | { id: number; kind: 'prompt'; options: PromptOptions; resolve: (v: string | null) => void };

interface State { toasts: ToastItem[]; dialogs: DialogRequest[] }

let state: State = { toasts: [], dialogs: [] };
let nextId = 1;
let hostsMounted = 0;
const listeners = new Set<() => void>();
const TOAST_MS = 5000;

function setState(next: State) {
  state = next;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => state;

/** Mounts a host when none is on the page (outside the app shell, or in a component test). */
function ensureHost() {
  if (hostsMounted > 0 || typeof document === 'undefined') return;
  const el = document.createElement('div');
  el.setAttribute('data-ui-feedback-host', 'auto');
  document.body.appendChild(el);
  createRoot(el).render(<UiFeedbackHost />);
  hostsMounted += 1; // counted now, so a second call before the first render does not mount another
}

function pushToast(tone: Tone, message: unknown) {
  const text = typeof message === 'string' && message.trim() ? message : tone === 'error' ? 'Something went wrong. Please try again.' : '';
  if (!text) return;
  ensureHost();
  const id = nextId++;
  setState({ ...state, toasts: [...state.toasts.slice(-3), { id, tone, message: text }] });
  setTimeout(() => dismissToast(id), TOAST_MS);
}
export function dismissToast(id: number) {
  if (!state.toasts.some((t) => t.id === id)) return;
  setState({ ...state, toasts: state.toasts.filter((t) => t.id !== id) });
}

export const toast = {
  error: (message: unknown) => pushToast('error', message),
  success: (message: unknown) => pushToast('success', message),
  info: (message: unknown) => pushToast('info', message),
};

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  ensureHost();
  return new Promise((resolve) => {
    setState({ ...state, dialogs: [...state.dialogs, { id: nextId++, kind: 'confirm', options, resolve }] });
  });
}

export function promptDialog(options: PromptOptions): Promise<string | null> {
  ensureHost();
  return new Promise((resolve) => {
    setState({ ...state, dialogs: [...state.dialogs, { id: nextId++, kind: 'prompt', options, resolve }] });
  });
}

function closeDialog(id: number) {
  setState({ ...state, dialogs: state.dialogs.filter((d) => d.id !== id) });
}

/** For tests: drop every toast and dialog (open dialogs resolve as cancelled). */
export function resetUiFeedback() {
  state.dialogs.forEach((d) => (d.kind === 'confirm' ? d.resolve(false) : d.resolve(null)));
  setState({ toasts: [], dialogs: [] });
}

// ---------------------------------------------------------------- rendering

/**
 * These dialogs can open over another modal (e.g. "Restore version" inside Version history).
 * Esc and Tab are handled here in the capture phase and stopped, so the modal underneath
 * neither closes on the same Esc nor pulls focus back with its own Tab trap.
 */
function useTopLayerKeys(ref: React.RefObject<HTMLElement | null>, onCancel: () => void) {
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current;
      if (!root) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        cancelRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      e.stopPropagation();
      const items = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href]'));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const outside = !active || !root.contains(active);
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ref]);
}

const ConfirmView: React.FC<{ req: Extract<DialogRequest, { kind: 'confirm' }> }> = ({ req }) => {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { options } = req;
  const done = (v: boolean) => {
    closeDialog(req.id);
    req.resolve(v);
  };
  useDialogFocus(ref, true, () => done(false), { initialFocusRef: cancelRef });
  useTopLayerKeys(ref, () => done(false));
  const titleId = `ui-confirm-title-${req.id}`;
  const bodyId = `ui-confirm-body-${req.id}`;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 ui-scrim" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={options.message ? bodyId : undefined} className="glass-modal w-full max-w-md p-5 space-y-4">
        <div className="flex items-start gap-3">
          {options.danger && (
            <span className="w-9 h-9 rounded-full bg-red-50 text-red-600 flex items-center justify-center shrink-0" aria-hidden="true">
              <AlertTriangle className="w-4 h-4" />
            </span>
          )}
          <div className="min-w-0 space-y-1">
            <h2 id={titleId} className="text-base font-bold text-ui-ink break-words">{options.title}</h2>
            {options.message && <div id={bodyId} className="text-sm text-ui-text break-words">{options.message}</div>}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={() => done(false)} className="ui-btn ui-btn-secondary h-11">
            {options.cancelLabel || 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => done(true)}
            data-testid="ui-confirm-ok"
            className={options.danger ? 'ui-btn h-11 bg-red-600 hover:bg-red-700 text-white border border-red-600' : 'ui-btn ui-btn-primary h-11'}
          >
            {options.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
};

const PromptView: React.FC<{ req: Extract<DialogRequest, { kind: 'prompt' }> }> = ({ req }) => {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const { options } = req;
  const [value, setValue] = useState(options.initialValue || '');
  const [showError, setShowError] = useState(false);
  const done = (v: string | null) => {
    closeDialog(req.id);
    req.resolve(v);
  };
  useDialogFocus(ref, true, () => done(null), { initialFocusRef: inputRef });
  useTopLayerKeys(ref, () => done(null));
  const trimmed = value.trim();
  const error =
    (options.required !== false && !trimmed ? `${options.label} is required.` : null) ||
    (options.maxLength && trimmed.length > options.maxLength ? `Keep it under ${options.maxLength} characters.` : null) ||
    (trimmed && options.validate ? options.validate(trimmed) : null);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setShowError(true);
    if (!error) done(trimmed);
  };
  const id = `ui-prompt-${req.id}`;
  const common = {
    id: `${id}-input`,
    ref: inputRef,
    value,
    placeholder: options.placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(e.target.value),
    'aria-invalid': showError && error ? true : undefined,
    'aria-describedby': showError && error ? `${id}-error` : undefined,
  };
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 ui-scrim" onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} className="glass-modal w-full max-w-md p-5">
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="flex items-start justify-between gap-3">
            <h2 id={`${id}-title`} className="text-base font-bold text-ui-ink break-words">{options.title}</h2>
            <button type="button" onClick={() => done(null)} className="ui-icon-btn h-11 w-11 shrink-0" aria-label="Close">
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
          {options.message && <div className="text-sm text-ui-text">{options.message}</div>}
          <div className="space-y-1.5">
            <label htmlFor={`${id}-input`} className="block text-[13px] font-medium text-ui-muted">{options.label}</label>
            {options.multiline ? (
              <textarea {...common} className="ui-input ui-textarea w-full min-h-[96px]" />
            ) : (
              <input {...common} type={options.inputType || 'text'} className="ui-input h-11 w-full" />
            )}
            {showError && error && <p id={`${id}-error`} role="alert" className="text-xs text-red-700">{error}</p>}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => done(null)} className="ui-btn ui-btn-secondary h-11">Cancel</button>
            <button type="submit" className="ui-btn ui-btn-primary h-11">{options.confirmLabel || 'OK'}</button>
          </div>
        </form>
      </div>
    </div>
  );
};

const TOAST_STYLE: Record<Tone, { icon: React.ElementType; cls: string }> = {
  error: { icon: XCircle, cls: 'text-red-600' },
  success: { icon: CheckCircle2, cls: 'text-emerald-600' },
  info: { icon: Info, cls: 'text-ui-muted' },
};

/** Renders the toasts and the open dialog (one at a time, oldest first). Mount once. */
export const UiFeedbackHost: React.FC = () => {
  const { toasts, dialogs } = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    hostsMounted += 1;
    return () => {
      hostsMounted -= 1;
    };
  }, []);
  const top = dialogs[0];
  return (
    <>
      {top && (top.kind === 'confirm' ? <ConfirmView key={top.id} req={top} /> : <PromptView key={top.id} req={top} />)}
      <div className="fixed z-[90] bottom-4 left-4 right-4 sm:left-auto sm:w-96 flex flex-col gap-2 pointer-events-none" aria-live="polite" role="status">
        {toasts.map((t) => {
          const { icon: Icon, cls } = TOAST_STYLE[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : undefined}
              data-testid={`toast-${t.tone}`}
              className="pointer-events-auto glass-modal border border-white shadow-xl rounded-2xl p-3 flex items-start gap-2.5 animate-in fade-in slide-in-from-bottom-2"
            >
              <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${cls}`} aria-hidden="true" />
              <p className="flex-1 min-w-0 text-sm text-ui-ink break-words">{t.message}</p>
              <button type="button" onClick={() => dismissToast(t.id)} className="ui-icon-btn h-7 w-7 shrink-0" aria-label="Dismiss">
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
};
