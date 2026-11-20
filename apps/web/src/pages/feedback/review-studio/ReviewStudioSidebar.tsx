import { isApprover, ROLE_LABELS, type UserRole } from '@mmp/shared';
import React, { useState } from 'react';
import {
  FileText,
  History,
  Layers,
  MessageSquare,
  Check,
  Clock,
  MapPin,
  ExternalLink,
  Copy,
} from 'lucide-react';
import { ReviewComment } from './ImageViewer';
import { Avatar } from '../../../components/Avatar';

interface VersionItem {
  id: string;
  versionNumber: number;
  submittedAt: string;
  status?: string;
  submittedBy?: {
    name?: string;
  };
}

interface UpstreamOutput {
  id: string;
  stageName: string;
  workerName: string;
  fileUrl?: string;
  contentUrl?: string;
  textContent?: string;
  metadata?: Record<string, any>;
  updatedAt: string;
}

interface ReviewStudioSidebarProps {
  canComment?: boolean;
  brief?:
    | {
        title?: string;
        description?: string;
        channel?: string;
        targetAudience?: string;
        hookIdea?: string;
        tone?: string;
        references?: string[];
      }
    | string;
  earlierOutputs?: UpstreamOutput[];
  versions?: VersionItem[];
  activeVersionId: string;
  onSelectVersion: (versionId: string) => void;
  comments: ReviewComment[];
  activeCommentId?: string | null;
  onSelectComment: (commentId: string) => void;
  onResolveComment?: (commentId: string, resolved: boolean) => void;
  onAddGeneralComment?: (text: string) => void;
  /** Reply to a comment (threaded, text only). Given to the step owner and the reviewers. */
  onReplyComment?: (parentId: string, text: string) => void | Promise<void>;
  /** The step owner's id: their replies are labelled "Owner". */
  ownerId?: string;
  /** True when the viewer is the step owner ("my review" mode). */
  viewerIsOwner?: boolean;
  isDiffMode?: boolean;
  onToggleDiffMode?: () => void;
}

export const ReviewStudioSidebar: React.FC<ReviewStudioSidebarProps> = ({
  brief: rawBrief,
  earlierOutputs = [],
  versions = [],
  activeVersionId,
  onSelectVersion,
  comments,
  activeCommentId,
  onSelectComment,
  onResolveComment,
  onAddGeneralComment,
  onReplyComment,
  ownerId,
  viewerIsOwner = false,
  canComment = true,
  isDiffMode = false,
  onToggleDiffMode,
}) => {
  const brief =
    typeof rawBrief === 'string'
      ? { title: 'Content Brief', description: rawBrief }
      : rawBrief;

  const [activeTab, setActiveTab] = useState<'comments' | 'brief' | 'upstream' | 'versions'>('comments');
  const [generalCommentText, setGeneralCommentText] = useState('');
  const [threadFilter, setThreadFilter] = useState<'all' | 'open' | 'resolved'>('all');
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [sendingReply, setSendingReply] = useState<string | null>(null);

  // Threads: first comments, each with its replies (oldest first).
  const authorIdOf = (c: ReviewComment) => (typeof c.author === 'object' ? String(c.author?.id || '') : '');
  const roots = comments.filter((c) => !c.parentId);
  const repliesOf = (id: string) =>
    comments.filter((c) => c.parentId === id).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const shownRoots = roots.filter((c) => (threadFilter === 'all' ? true : threadFilter === 'open' ? !c.resolved : Boolean(c.resolved)));
  const isOwnerAuthor = (c: ReviewComment) => Boolean(ownerId && authorIdOf(c) === String(ownerId));
  const roleLabel = (c: ReviewComment) => {
    if (isOwnerAuthor(c)) return 'Owner';
    const role = typeof c.author === 'object' ? c.author?.role : undefined;
    if (!role) return '';
    return ROLE_LABELS[role as UserRole] || (isApprover(role) ? 'Lead' : role);
  };
  const sendReply = async (rootId: string) => {
    const text = (replyDrafts[rootId] || '').trim();
    if (!text || !onReplyComment) return;
    setSendingReply(rootId);
    try {
      await onReplyComment(rootId, text);
      setReplyDrafts((d) => ({ ...d, [rootId]: '' }));
    } finally {
      setSendingReply(null);
    }
  };
  const [copiedText, setCopiedText] = useState(false);

  const formatTimecode = (seconds?: number) => {
    if (seconds === undefined || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 2000);
  };

  const handleAddComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!generalCommentText.trim()) return;
    onAddGeneralComment?.(generalCommentText.trim());
    setGeneralCommentText('');
  };

  return (
    <div className="flex flex-col h-full glass-panel md:rounded-none md:border-y-0 md:border-r-0 text-ui-text">
      {/* Tab Navigation */}
      <div className="px-3 pt-3 pb-2 border-b border-ui-line">
      <div role="tablist" aria-label="Review details" className="ui-tabs w-full grid grid-cols-2 sm:grid-cols-4 md:grid-cols-2 rounded-ui-card">
        <button
          role="tab"
          aria-selected={activeTab === 'comments'}
          type="button"
          onClick={() => setActiveTab('comments')}
          className="ui-tab justify-center gap-1.5 px-2 text-xs"
        >
          <MessageSquare className="w-3.5 h-3.5" aria-hidden="true" />
          Comments ({comments.length})
        </button>

        <button
          role="tab"
          aria-selected={activeTab === 'brief'}
          type="button"
          onClick={() => setActiveTab('brief')}
          className="ui-tab justify-center gap-1.5 px-2 text-xs"
        >
          <FileText className="w-3.5 h-3.5" aria-hidden="true" />
          Brief
        </button>

        <button
          role="tab"
          aria-selected={activeTab === 'upstream'}
          type="button"
          onClick={() => setActiveTab('upstream')}
          className="ui-tab justify-center gap-1.5 px-2 text-xs"
        >
          <Layers className="w-3.5 h-3.5" aria-hidden="true" />
          Outputs ({earlierOutputs.length})
        </button>

        <button
          role="tab"
          aria-selected={activeTab === 'versions'}
          type="button"
          onClick={() => setActiveTab('versions')}
          className="ui-tab justify-center gap-1.5 px-2 text-xs"
        >
          <History className="w-3.5 h-3.5" aria-hidden="true" />
          Versions ({versions.length})
        </button>
      </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* COMMENTS TAB */}
        {activeTab === 'comments' && (
          <div className="space-y-4">
            {/* Quick add comment form */}
            {canComment && <form onSubmit={handleAddComment} className="space-y-2">
              <textarea
                value={generalCommentText}
                onChange={(e) => setGeneralCommentText(e.target.value)}
                placeholder="Leave feedback on this deliverable... (shortcut: C)"
                aria-label="Comment on this deliverable"
                rows={2}
                className="ui-input ui-textarea w-full"
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={!generalCommentText.trim()}
                  className="ui-btn ui-btn-primary h-11"
                >
                  Post Comment
                </button>
              </div>
            </form>}

            <div className="ui-tabs" role="group" aria-label="Show comments">
              {(['all', 'open', 'resolved'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={threadFilter === f}
                  onClick={() => setThreadFilter(f)}
                  className={`ui-tab ${threadFilter === f ? 'is-active' : ''}`}
                >
                  {f === 'all'
                    ? `All (${roots.length})`
                    : f === 'open'
                      ? `Unresolved (${roots.filter((c) => !c.resolved).length})`
                      : `Resolved (${roots.filter((c) => c.resolved).length})`}
                </button>
              ))}
            </div>

            <div className="space-y-2">
              {shownRoots.length === 0 ? (
                <div className="text-center py-8 text-ui-muted text-xs">
                  <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" aria-hidden="true" />
                  <p>{roots.length === 0 ? (viewerIsOwner ? 'No comments from the reviewer yet.' : 'No comments pinned yet.') : 'No comments here.'}</p>
                  {canComment && roots.length === 0 && (
                    <p className="text-[11px] mt-1 text-ui-muted">
                      Select text in documents, click timeline in video, or click image to drop a pin.
                    </p>
                  )}
                </div>
              ) : (
                shownRoots.map((comment) => {
                  const idx = roots.indexOf(comment);
                  const isSelected = activeCommentId === comment.id;
                  const replies = repliesOf(comment.id);
                  const last = replies[replies.length - 1];
                  // For the reviewer: an open comment whose latest reply is the owner's.
                  const newReply = !viewerIsOwner && !comment.resolved && Boolean(last && isOwnerAuthor(last));
                  return (
                    <div
                      key={comment.id}
                      data-testid="review-thread"
                      className={`rounded-xl border transition-colors ${
                        isSelected
                          ? 'bg-white border-ui-ink outline outline-1 outline-ui-ink'
                          : 'bg-white/60 border-ui-line hover:bg-white'
                      }`}
                    >
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => onSelectComment(comment.id)}
                        className="block w-full text-left p-3 rounded-xl"
                      >
                        <span className="flex items-center justify-between gap-2 mb-1.5">
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="w-5 h-5 rounded-full bg-ui-ink text-[10px] font-bold text-white flex items-center justify-center shrink-0">
                              {idx + 1}
                            </span>
                            <Avatar
                              url={typeof comment.author === 'object' ? (comment.author as any)?.avatarUrl : null}
                              name={typeof comment.author === 'string' ? comment.author : comment.author?.name || 'Reviewer'}
                              userId={typeof comment.author === 'object' ? (comment.author as any)?._id : undefined}
                              size="xs"
                            />
                            <span className="text-xs font-semibold text-ui-ink truncate">
                              {typeof comment.author === 'string' ? comment.author : comment.author?.name || 'Reviewer'}
                            </span>
                            {roleLabel(comment) && (
                              <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-white text-ui-text border border-ui-line shrink-0">
                                {roleLabel(comment)}
                              </span>
                            )}
                            {newReply && (
                              <span className="status-chip status-waiting text-[11px] shrink-0" data-testid="new-reply-badge">
                                New reply
                              </span>
                            )}
                          </span>
                          <span className="text-[11px] text-ui-muted shrink-0">
                            {new Date(comment.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </span>

                        {/* Anchor badge */}
                        {comment.anchor && (
                          <span className="block mb-2">
                            {comment.anchor.type === 'timecode' && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded status-chip status-waiting">
                                <Clock className="w-3 h-3" aria-hidden="true" />
                                {formatTimecode(comment.anchor.timecode)}
                              </span>
                            )}
                            {comment.anchor.type === 'point' && comment.anchor.coordinates && (
                              <span className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded status-chip status-in-progress">
                                <MapPin className="w-3 h-3" aria-hidden="true" />
                                Pin ({comment.anchor.coordinates.x}%, {comment.anchor.coordinates.y}%)
                              </span>
                            )}
                            {comment.anchor.type === 'text' && comment.anchor.text && (
                              <span className="block text-[11px] italic text-ui-muted border-l-2 border-ui-ink pl-2 line-clamp-2 my-1">
                                &ldquo;{comment.anchor.text}&rdquo;
                              </span>
                            )}
                          </span>
                        )}

                        <span className="block text-xs text-ui-text whitespace-pre-wrap break-words">{comment.content}</span>
                        {comment.resolved && !onResolveComment && (
                          <span className="inline-flex items-center gap-1 mt-1.5 status-chip status-approved text-[11px]">
                            <Check className="w-3 h-3" aria-hidden="true" /> Resolved
                          </span>
                        )}
                      </button>

                      {replies.length > 0 && (
                        <ul className="mx-3 mb-2 pl-3 border-l-2 border-ui-line space-y-2" aria-label="Replies">
                          {replies.map((r) => (
                            <li key={r.id} data-testid="review-reply" className="text-xs">
                              <span className="flex items-center gap-1.5">
                                <span className="font-semibold text-ui-ink">
                                  {typeof r.author === 'string' ? r.author : r.author?.name || 'Reviewer'}
                                </span>
                                {roleLabel(r) && <span className="text-[11px] text-ui-muted">{roleLabel(r)}</span>}
                                <span className="text-[11px] text-ui-muted ml-auto">
                                  {new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                              </span>
                              <span className="block text-ui-text whitespace-pre-wrap break-words">{r.content}</span>
                            </li>
                          ))}
                        </ul>
                      )}

                      {onReplyComment && (
                        <form
                          className="mx-3 mb-3 flex items-end gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            sendReply(comment.id);
                          }}
                        >
                          <label htmlFor={`reply-${comment.id}`} className="sr-only">
                            Reply to comment {idx + 1}
                          </label>
                          <textarea
                            id={`reply-${comment.id}`}
                            rows={1}
                            value={replyDrafts[comment.id] || ''}
                            onChange={(e) => setReplyDrafts((d) => ({ ...d, [comment.id]: e.target.value }))}
                            placeholder="Reply…"
                            className="ui-input ui-textarea w-full min-h-[44px] text-xs"
                          />
                          <button
                            type="submit"
                            disabled={!(replyDrafts[comment.id] || '').trim() || sendingReply === comment.id}
                            className="ui-btn ui-btn-secondary h-11 shrink-0"
                          >
                            {sendingReply === comment.id ? 'Sending…' : 'Reply'}
                          </button>
                        </form>
                      )}

                      {onResolveComment && (
                        <div className="mx-3 pt-1 pb-1 border-t border-ui-line flex justify-end">
                          <button
                            type="button"
                            aria-pressed={Boolean(comment.resolved)}
                            onClick={(e) => {
                              e.stopPropagation();
                              onResolveComment(comment.id, !comment.resolved);
                            }}
                            className={`text-[13px] font-medium flex items-center gap-1 min-h-[44px] px-3 rounded-full ${
                              comment.resolved ? 'status-chip status-approved' : 'text-ui-muted hover:text-ui-ink'
                            }`}
                          >
                            <Check className="w-3 h-3" aria-hidden="true" />
                            {comment.resolved ? 'Resolved' : 'Mark as resolved'}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {activeTab === 'brief' && (
          <div className="space-y-4 text-xs">
            {brief ? (
              <>
                <div>
                  <h4 className="text-[13px] font-medium text-ui-muted mb-1">
                    Title & Objective
                  </h4>
                  <p className="text-sm font-bold text-ui-ink">{brief.title || 'Untitled Piece'}</p>
                  {brief.description && (
                    <p className="text-ui-text mt-1 whitespace-pre-wrap">{brief.description}</p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2 pt-2">
                  <div className="p-2.5 rounded-lg bg-white/60">
                    <span className="text-ui-muted block text-[11px]">Channel</span>
                    <span className="font-semibold text-ui-ink">{brief.channel || 'General'}</span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white/60">
                    <span className="text-ui-muted block text-[11px]">Tone</span>
                    <span className="font-semibold text-ui-ink">{brief.tone || 'On Brand'}</span>
                  </div>
                </div>

                {brief.hookIdea && (
                  <div className="p-3 rounded-lg status-tint status-waiting">
                    <span className="font-bold block mb-1">Hook Angle:</span>
                    <p>{brief.hookIdea}</p>
                  </div>
                )}

                {brief.targetAudience && (
                  <div>
                    <span className="text-ui-muted block mb-1">Target Audience:</span>
                    <p className="text-ui-text">{brief.targetAudience}</p>
                  </div>
                )}

                {brief.references && brief.references.length > 0 && (
                  <div>
                    <span className="text-ui-muted block mb-1">Reference Links:</span>
                    <ul className="space-y-1">
                      {brief.references.map((refUrl, i) => (
                        <li key={i}>
                          <a
                            href={refUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-ui-ink underline-offset-4 hover:underline flex items-center gap-1 truncate min-h-[44px]"
                          >
                            <ExternalLink className="w-3 h-3 flex-shrink-0" />
                            {refUrl}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <p className="text-ui-muted">No brief attached to this content item.</p>
            )}
          </div>
        )}

        {/* UPSTREAM OUTPUTS TAB */}
        {activeTab === 'upstream' && (
          <div className="space-y-3">
            {earlierOutputs.length === 0 ? (
              <p className="text-xs text-ui-muted">No earlier stage outputs found.</p>
            ) : (
              earlierOutputs.map((out) => (
                <div
                  key={out.id}
                  className="p-3 rounded-xl bg-white/60 space-y-2 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-ui-ink">{out.stageName}</span>
                    <span className="text-[11px] text-ui-muted font-mono">
                      by {out.workerName}
                    </span>
                  </div>

                  {out.textContent && (
                    <div className="relative p-2 pr-12 rounded-lg bg-white max-h-36 overflow-y-auto">
                      <p className="text-ui-text text-[11px] whitespace-pre-wrap">
                        {out.textContent}
                      </p>
                      <button
                        type="button"
                        onClick={() => handleCopy(out.textContent!)}
                        className="ui-icon-btn absolute top-0 right-0 border-transparent"
                        title="Copy text"
                        aria-label={copiedText ? 'Text copied' : 'Copy text'}
                      >
                        {copiedText ? (
                          <Check className="w-3 h-3" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                    </div>
                  )}

                  {out.fileUrl && (
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-ui-muted truncate max-w-[180px]">Attached File</span>
                      <a
                        href={out.fileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-ui-ink underline-offset-4 hover:underline inline-flex items-center gap-1 font-semibold min-h-[44px]"
                      >
                        <ExternalLink className="w-3 h-3" />
                        View File
                      </a>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* VERSIONS TAB */}
        {activeTab === 'versions' && (
          <div className="space-y-3">
            {onToggleDiffMode && (
              <div className="p-3 rounded-xl bg-white/60 flex items-center justify-between gap-2">
                <div>
                  <span className="text-xs font-semibold text-ui-ink block">Version Compare Diff</span>
                  <span className="text-[11px] text-ui-muted">
                    Highlight additions & deletions
                  </span>
                </div>
                <button
                  type="button"
                  aria-pressed={Boolean(isDiffMode)}
                  onClick={onToggleDiffMode}
                  className={`ui-btn h-11 shrink-0 ${isDiffMode ? 'ui-btn-primary' : 'ui-btn-secondary'}`}
                >
                  {isDiffMode ? 'Diff Active' : 'Compare'}
                </button>
              </div>
            )}

            <div className="space-y-2">
              {versions.map((ver) => {
                const isActive = activeVersionId === ver.id;
                return (
                  <button
                    key={ver.id}
                    type="button"
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => onSelectVersion(ver.id)}
                    className={`w-full p-3 rounded-xl border text-left transition-colors flex items-center justify-between gap-2 ${
                      isActive
                        ? 'bg-white border-ui-ink text-ui-ink font-medium outline outline-1 outline-ui-ink'
                        : 'bg-white/60 border-ui-line text-ui-text hover:bg-white'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs">Version {ver.versionNumber}</span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-white/70 text-ui-text border border-ui-line">
                          {ver.status}
                        </span>
                      </div>
                      <span className="text-[11px] text-ui-muted block mt-0.5">
                        {new Date(ver.submittedAt).toLocaleDateString()} by{' '}
                        {ver.submittedBy?.name || 'Creator'}
                      </span>
                    </div>
                    {isActive && <Check className="w-4 h-4 text-ui-ink shrink-0" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
