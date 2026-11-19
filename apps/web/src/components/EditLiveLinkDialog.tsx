import React, { useRef, useState } from 'react';
import { Link2, X } from 'lucide-react';
import { embedPreviewText, livePostUrlError } from '@mmp/shared';
import { apiFetch } from '../lib/api';
import { useDialogFocus } from '../lib/useDialogFocus';

/** Who may correct a posted piece's live link (the API checks again). */
export const canEditLiveLink = (role: string | null | undefined) => role === 'sm_manager' || role === 'admin';

interface Props {
  pieceId: string;
  title: string;
  currentUrl: string;
  onClose: () => void;
  /** Called with the saved link. */
  onSaved: (liveUrl: string) => void | Promise<void>;
}

/**
 * Edit live link (Published page, Work Detail of the Post step, Tracker): same rule as posting
 * (https, not a site homepage) with the embed preview line. Updates the piece and its Post step
 * together; the posted date is kept.
 */
export const EditLiveLinkDialog: React.FC<Props> = ({ pieceId, title, currentUrl, onClose, onSaved }) => {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useDialogFocus(ref, true, onClose, { initialFocusRef: inputRef });
  const [value, setValue] = useState(currentUrl || '');
  const [showError, setShowError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const problem = livePostUrlError(value.trim());

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setShowError(true);
    setServerError(null);
    if (problem) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ data: { liveUrl: string } }>(`/api/published/${pieceId}/live-link`, {
        method: 'PUT',
        body: JSON.stringify({ liveUrl: value.trim() }),
      });
      await onSaved(res?.data?.liveUrl || value.trim());
    } catch (err: any) {
      setServerError(err?.message || 'Could not save the live link.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 ui-scrim">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="edit-live-link-title" className="glass-modal w-full max-w-md p-5">
        <form onSubmit={save} className="space-y-4" noValidate>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex items-start gap-2">
              <Link2 className="w-5 h-5 text-ui-ink shrink-0 mt-0.5" aria-hidden="true" />
              <div className="min-w-0">
                <h2 id="edit-live-link-title" className="text-base font-bold text-ui-ink">Edit live link</h2>
                <p className="text-sm text-ui-muted break-words">{title}</p>
              </div>
            </div>
            <button type="button" onClick={onClose} className="ui-icon-btn h-11 w-11 shrink-0" aria-label="Close">
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="edit-live-link-input" className="block text-[13px] font-medium text-ui-muted">Live post link</label>
            <input
              ref={inputRef}
              id="edit-live-link-input"
              type="url"
              inputMode="url"
              className="ui-input w-full min-w-0"
              placeholder="https://www.instagram.com/reel/..."
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={showError && problem ? true : undefined}
              aria-describedby={showError && problem ? 'edit-live-link-error' : 'edit-live-link-hint'}
            />
            {showError && problem && (
              <p id="edit-live-link-error" role="alert" className="text-xs text-red-700">{problem}</p>
            )}
            {!problem && (
              <p data-testid="embed-preview" aria-live="polite" className="text-xs text-ui-muted">{embedPreviewText(value.trim())}</p>
            )}
            <p id="edit-live-link-hint" className="text-xs text-ui-muted">The posted date stays the same.</p>
          </div>
          {serverError && <p role="alert" className="p-3 rounded-xl status-tint status-changes text-xs font-semibold">{serverError}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={onClose} className="ui-btn ui-btn-secondary h-11">Cancel</button>
            <button type="submit" disabled={busy} className="ui-btn ui-btn-primary h-11">{busy ? 'Saving…' : 'Save link'}</button>
          </div>
        </form>
      </div>
    </div>
  );
};
