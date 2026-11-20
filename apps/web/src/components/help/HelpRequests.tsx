import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ExternalLink, HelpCircle, Send, X } from 'lucide-react';
import { HELP_MESSAGE_MAX, HELP_REPLY_MAX, HELP_TOPICS, HELP_TOPIC_LABELS, isHttpsUrl, type HelpTopic } from '@mmp/shared';
import { apiFetch } from '../../lib/api';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { safeUrl } from '../../lib/safeUrl';
import { toast } from '../../lib/uiFeedback';

/** A person the step owner can ask (from the API: the deciding lead first, SM Managers, other step owners). */
export interface HelpOption { kind: 'lead' | 'sm_manager' | 'step_owner'; personId: string; name: string; label: string }
export interface HelpRequestView {
  _id: string;
  topic: HelpTopic;
  topicLabel: string;
  message: string;
  link: string;
  status: 'open' | 'resolved';
  asker: { _id: string; name: string };
  helper: { _id: string; name: string; kind: HelpOption['kind'] };
  createdAt: string;
  replies: Array<{ _id: string; author: { _id: string; name: string }; text: string; at: string }>;
  resolvedBy: { _id: string; name: string } | null;
  resolvedAt: string | null;
  canReply: boolean;
  canResolve: boolean;
}
export interface HelpData {
  open: HelpRequestView[];
  resolved: HelpRequestView[];
  openCount: number;
  canAsk: boolean;
  options: HelpOption[];
  defaultHelperId: string | null;
}

export const helpApi = {
  list: (stepId: string) => apiFetch<{ data: HelpData }>(`/api/work/${stepId}/help-requests`).then((r) => r.data),
  create: (stepId: string, body: { helperId: string; topic: HelpTopic; message: string; link?: string }) =>
    apiFetch<{ data: HelpRequestView }>(`/api/work/${stepId}/help-requests`, { method: 'POST', body: JSON.stringify(body) }),
  reply: (stepId: string, helpId: string, text: string) =>
    apiFetch(`/api/work/${stepId}/help-requests/${helpId}/replies`, { method: 'POST', body: JSON.stringify({ text }) }),
  resolve: (stepId: string, helpId: string) => apiFetch(`/api/work/${stepId}/help-requests/${helpId}/resolve`, { method: 'POST' }),
};

/** Loads a step's help requests. A 404 (no share in them) gives null: nothing is shown. */
export function useHelpRequests(stepId: string | undefined) {
  const [data, setData] = useState<HelpData | null>(null);
  const reload = useCallback(async () => {
    if (!stepId) return;
    try {
      const d = await helpApi.list(stepId);
      setData(d && Array.isArray(d.open) && Array.isArray(d.resolved) ? { ...d, options: Array.isArray(d.options) ? d.options : [] } : null);
    } catch {
      setData(null);
    }
  }, [stepId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, reload };
}

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '';

const GROUP_LABEL: Record<HelpOption['kind'], string> = { lead: 'Lead for this step', sm_manager: 'SM Manager', step_owner: 'Owner of another step' };

/** "Ask for help": who, topic, message (required, up to 1,000 characters), optional https link. */
export const AskForHelpDialog: React.FC<{
  stepId: string;
  stepTitle: string;
  options: HelpOption[];
  defaultHelperId: string | null;
  onClose: () => void;
  onSent: () => void | Promise<void>;
}> = ({ stepId, stepTitle, options, defaultHelperId, onClose, onSent }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, true, onClose);
  const [helperId, setHelperId] = useState(defaultHelperId || options[0]?.personId || '');
  const [topic, setTopic] = useState<HelpTopic | ''>('');
  const [message, setMessage] = useState('');
  const [link, setLink] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors = {
    helperId: !helperId ? 'Choose who should help.' : null,
    topic: !topic ? 'Choose a topic.' : null,
    message: !message.trim() ? 'Write what you need help with.' : message.trim().length > HELP_MESSAGE_MAX ? `Keep it under ${HELP_MESSAGE_MAX} characters.` : null,
    link: link.trim() && !isHttpsUrl(link) ? 'The link must start with https://' : null,
  };
  const invalid = Object.values(errors).some(Boolean);
  const err = (k: keyof typeof errors) => (showErrors ? errors[k] : null);
  const groups = (['lead', 'sm_manager', 'step_owner'] as const).map((kind) => ({ kind, items: options.filter((o) => o.kind === kind) })).filter((g) => g.items.length);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    setError(null);
    if (invalid || !topic) return;
    setBusy(true);
    try {
      await helpApi.create(stepId, { helperId, topic, message: message.trim(), link: link.trim() || undefined });
      const who = options.find((o) => o.personId === helperId)?.name;
      toast.success(who ? `Help request sent to ${who}.` : 'Help request sent.');
      await onSent();
    } catch (ex: any) {
      setError(ex?.message || 'Could not send the request.');
    } finally {
      setBusy(false);
    }
  };

  const fieldErr = (k: keyof typeof errors, id: string) =>
    err(k) ? <p id={id} role="alert" className="text-xs text-red-700">{err(k)}</p> : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 ui-scrim">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="ask-help-title" className="glass-modal w-full max-w-md p-5 max-h-[92vh] overflow-y-auto" data-testid="ask-help-dialog">
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="ask-help-title" className="text-base font-bold text-ui-ink">Ask for help</h2>
              <p className="text-sm text-ui-muted break-words">{stepTitle}</p>
            </div>
            <button type="button" onClick={onClose} className="ui-icon-btn h-11 w-11 shrink-0" aria-label="Close">
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
          <p className="text-xs text-ui-muted">The person you choose gets one notification with a link to this step. Asking for help does not pause the step or change its work time.</p>

          <div className="space-y-1.5">
            <label htmlFor="help-helper" className="block text-[13px] font-medium text-ui-muted">Who should help</label>
            <select
              id="help-helper"
              className="ui-select h-11 w-full"
              value={helperId}
              onChange={(e) => setHelperId(e.target.value)}
              aria-invalid={err('helperId') ? true : undefined}
              aria-describedby={err('helperId') ? 'help-helper-error' : undefined}
            >
              {!options.length && <option value="">No one available</option>}
              {groups.map((g) => (
                <optgroup key={g.kind} label={GROUP_LABEL[g.kind]}>
                  {g.items.map((o) => <option key={o.personId} value={o.personId}>{o.label}</option>)}
                </optgroup>
              ))}
            </select>
            {fieldErr('helperId', 'help-helper-error')}
          </div>

          <fieldset className="space-y-2" aria-describedby={err('topic') ? 'help-topic-error' : undefined}>
            <legend className="text-[13px] font-medium text-ui-muted">Topic</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {HELP_TOPICS.map((t) => (
                <label key={t} className={`flex items-center gap-2 min-h-[44px] px-3 rounded-xl border cursor-pointer ${topic === t ? 'border-ui-ink bg-white' : 'border-ui-line bg-white/60'}`}>
                  <input type="radio" name="help-topic" value={t} checked={topic === t} onChange={() => setTopic(t)} />
                  <span className="text-sm text-ui-ink">{HELP_TOPIC_LABELS[t]}</span>
                </label>
              ))}
            </div>
            {fieldErr('topic', 'help-topic-error')}
          </fieldset>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor="help-message" className="block text-[13px] font-medium text-ui-muted">Message</label>
              <span className={`text-[11px] ${message.trim().length > HELP_MESSAGE_MAX ? 'text-red-700' : 'text-ui-muted'}`}>{message.trim().length}/{HELP_MESSAGE_MAX}</span>
            </div>
            <textarea
              id="help-message"
              className="ui-input ui-textarea w-full min-h-[110px]"
              value={message}
              maxLength={HELP_MESSAGE_MAX + 100}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What do you need, and what have you tried?"
              aria-invalid={err('message') ? true : undefined}
              aria-describedby={err('message') ? 'help-message-error' : undefined}
            />
            {fieldErr('message', 'help-message-error')}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="help-link" className="block text-[13px] font-medium text-ui-muted">Link (optional)</label>
            <input
              id="help-link"
              type="url"
              inputMode="url"
              className="ui-input h-11 w-full"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://"
              aria-invalid={err('link') ? true : undefined}
              aria-describedby={err('link') ? 'help-link-error' : undefined}
            />
            {fieldErr('link', 'help-link-error')}
          </div>

          {error && <p role="alert" className="p-3 rounded-xl status-tint status-changes text-xs font-semibold">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={onClose} className="ui-btn ui-btn-secondary h-11">Cancel</button>
            <button type="submit" disabled={busy || !options.length} className="ui-btn ui-btn-primary h-11 gap-1.5">
              <Send className="w-3.5 h-3.5" aria-hidden="true" />
              {busy ? 'Sending…' : 'Send request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

/** One request: what was asked, by whom, to whom, when; the replies; reply and resolve when allowed. */
const HelpRequestItem: React.FC<{ stepId: string; r: HelpRequestView; onChanged: () => void | Promise<void> }> = ({ stepId, r, onChanged }) => {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState<'reply' | 'resolve' | null>(null);
  const [replyError, setReplyError] = useState<string | null>(null);
  const href = r.link ? safeUrl(r.link) : undefined;
  const open = r.status === 'open';

  const sendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = reply.trim();
    if (!text) return setReplyError('Write a reply.');
    if (text.length > HELP_REPLY_MAX) return setReplyError(`Keep it under ${HELP_REPLY_MAX} characters.`);
    setReplyError(null);
    setBusy('reply');
    try {
      await helpApi.reply(stepId, r._id, text);
      setReply('');
      await onChanged();
    } catch (ex: any) {
      toast.error(ex?.message || 'Could not send the reply.');
    } finally {
      setBusy(null);
    }
  };
  const resolve = async () => {
    setBusy('resolve');
    try {
      await helpApi.resolve(stepId, r._id);
      toast.success('Help request marked resolved.');
      await onChanged();
    } catch (ex: any) {
      toast.error(ex?.message || 'Could not resolve the request.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="p-3 rounded-xl bg-white/80 border border-ui-line space-y-2" data-testid={open ? 'help-request-open' : 'help-request-resolved'}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`status-chip ${open ? 'status-waiting' : 'status-approved'} text-[11px]`}>{r.topicLabel}</span>
        <span className="text-[12px] text-ui-muted">
          <span className="font-semibold text-ui-text">{r.asker.name || 'Someone'}</span> asked{' '}
          <span className="font-semibold text-ui-text">{r.helper.name || 'someone'}</span> · {when(r.createdAt)}
        </span>
      </div>
      <p className="text-sm text-ui-ink whitespace-pre-wrap break-words">{r.message}</p>
      {href && (
        <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-ui-ink underline break-all">
          <ExternalLink className="w-3 h-3 shrink-0" aria-hidden="true" />
          {r.link}
        </a>
      )}
      {r.replies.length > 0 && (
        <ul className="space-y-1.5 pl-3 border-l-2 border-ui-line" aria-label="Replies">
          {r.replies.map((x) => (
            <li key={x._id} className="text-[13px]">
              <span className="font-semibold text-ui-ink">{x.author.name || 'Someone'}</span>
              <span className="text-ui-muted"> · {when(x.at)}</span>
              <p className="text-ui-text whitespace-pre-wrap break-words">{x.text}</p>
            </li>
          ))}
        </ul>
      )}
      {!open && r.resolvedAt && (
        <p className="text-[12px] text-ui-muted">Resolved by {r.resolvedBy?.name || 'someone'} · {when(r.resolvedAt)}</p>
      )}
      {open && (r.canReply || r.canResolve) && (
        <div className="space-y-2 pt-1">
          {r.canReply && (
            <form onSubmit={sendReply} className="flex flex-col sm:flex-row gap-2" noValidate>
              <label htmlFor={`help-reply-${r._id}`} className="sr-only">Reply</label>
              <input
                id={`help-reply-${r._id}`}
                className="ui-input h-11 flex-1 min-w-0"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Write a reply…"
                maxLength={HELP_REPLY_MAX + 50}
                aria-invalid={replyError ? true : undefined}
                aria-describedby={replyError ? `help-reply-err-${r._id}` : undefined}
              />
              <div className="flex gap-2">
                <button type="submit" disabled={busy !== null} className="ui-btn ui-btn-secondary h-11 gap-1.5 flex-1 sm:flex-none">
                  <Send className="w-3.5 h-3.5" aria-hidden="true" />
                  {busy === 'reply' ? 'Sending…' : 'Reply'}
                </button>
                {r.canResolve && (
                  <button type="button" onClick={resolve} disabled={busy !== null} className="ui-btn ui-btn-primary h-11 gap-1.5 flex-1 sm:flex-none" data-testid="help-resolve">
                    <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                    {busy === 'resolve' ? 'Saving…' : 'Mark resolved'}
                  </button>
                )}
              </div>
            </form>
          )}
          {replyError && <p id={`help-reply-err-${r._id}`} role="alert" className="text-xs text-red-700">{replyError}</p>}
        </div>
      )}
    </li>
  );
};

/** Work Detail: open help requests, then resolved ones collapsed under History. Hidden when there are none. */
export const HelpRequestsCard: React.FC<{ stepId: string; data: HelpData | null; onChanged: () => void | Promise<void> }> = ({ stepId, data, onChanged }) => {
  const ref = useRef<HTMLElement>(null);
  const shown = Boolean(data && (data.open.length > 0 || data.resolved.length > 0));
  // Notification links end in #help: the card loads after the page, so scroll to it once it is there.
  useEffect(() => {
    if (shown && window.location.hash === '#help') ref.current?.scrollIntoView?.({ block: 'start' });
  }, [shown]);
  if (!data || !shown) return null;
  return (
    <section ref={ref} id="help" aria-labelledby="help-card-title" className="p-4 rounded-ui-card bg-white/60 border border-ui-line space-y-3 scroll-mt-24" data-testid="help-card">
      <h2 id="help-card-title" className="flex items-center gap-2 text-sm font-bold text-ui-ink">
        <HelpCircle className="w-4 h-4" aria-hidden="true" />
        Help requests
        {data.open.length > 0 && <span className="status-chip status-waiting text-[11px]">{data.open.length} open</span>}
      </h2>
      {data.open.length > 0 ? (
        <ul className="space-y-2">
          {data.open.map((r) => <HelpRequestItem key={r._id} stepId={stepId} r={r} onChanged={onChanged} />)}
        </ul>
      ) : (
        <p className="text-xs text-ui-muted">No open help requests.</p>
      )}
      {data.resolved.length > 0 && (
        <details className="group">
          <summary className="flex items-center gap-1.5 min-h-[44px] cursor-pointer text-xs font-semibold text-ui-muted hover:text-ui-ink list-none">
            <ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
            History ({data.resolved.length} resolved)
          </summary>
          <ul className="space-y-2 mt-2">
            {data.resolved.map((r) => <HelpRequestItem key={r._id} stepId={stepId} r={r} onChanged={onChanged} />)}
          </ul>
        </details>
      )}
    </section>
  );
};
