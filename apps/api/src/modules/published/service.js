import {
  CALENDAR_KEYS,
  ROW_WORKFLOWS,
  isMonthKey,
  istDateKey,
  isWorker,
  livePostUrlError,
  normalizeRole,
  toEmbed,
  workflowFromFlags,
  workflowLabel,
} from '@mmp/shared';
import { ContentPiece } from '../calendar/contentPiece.model.js';
import mongoose from 'mongoose';
import { WorkItem } from '../workItems/model.js';
import { approvedOutputOf, canSeeStepOutput } from '../workItems/access.js';
import { outputItems } from '../workItems/handoff.js';
import { logActivity } from '../activity/service.js';

/**
 * Published page: every posted piece with its live link, newest first. Read-only.
 * Posted date: the piece's publishedAt, else its Post step's postedAt; live link: the piece's
 * liveUrl, else the Post step's publishedUrl. Leadership, admin and the SM Manager see every
 * piece; a worker (executive) sees only pieces where they owned a step. Credits carry step
 * names and owner names only (no contact details). Nothing is sorted, grouped or counted by person.
 */

const FINISHED = ['Approved', 'Published'];
export const PUBLISHED_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 60;

function badRequest(message, field) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'INVALID_FILTER';
  error.details = { field };
  return error;
}

/** Filters from the query string; throws 400 on a malformed one. */
export function parsePublishedQuery(query = {}) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const month = str(query.month);
  const calendar = str(query.calendar);
  const type = str(query.type);
  const workflow = str(query.workflow);
  const q = str(query.q || query.search).slice(0, 100);
  if (month && !isMonthKey(month)) throw badRequest('Month must be YYYY-MM.', 'month');
  if (calendar && !CALENDAR_KEYS.includes(calendar)) throw badRequest(`Unknown calendar "${calendar}".`, 'calendar');
  if (workflow && !ROW_WORKFLOWS.includes(workflow)) throw badRequest(`Unknown workflow "${workflow}".`, 'workflow');
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(query.limit) || PUBLISHED_PAGE_SIZE)));
  return { month, calendar, type, workflow, q, page, limit };
}

export async function listPublished(query, user) {
  const f = parsePublishedQuery(query);
  const role = normalizeRole(user.role);
  const userId = String(user._id || user.userId || user.id || '');

  // Posted Post steps: the fallback date and link, and pieces posted only through the step.
  const postSteps = await WorkItem.find({ stageKey: 'Post', postedAt: { $ne: null }, contentPieceId: { $ne: null } })
    .select('contentPieceId postedAt publishedUrl')
    .lean();
  const postByPiece = new Map(postSteps.map((s) => [String(s.contentPieceId), s]));

  const pieceQuery = { $or: [{ publishedAt: { $ne: null } }, { _id: { $in: postSteps.map((s) => s.contentPieceId) } }] };
  if (isWorker(role)) {
    // Workers: only pieces where they owned a step.
    const mine = await WorkItem.distinct('contentPieceId', { ownerId: userId, contentPieceId: { $ne: null } });
    pieceQuery._id = { $in: mine };
  }
  if (f.type) pieceQuery.contentType = f.type;
  if (f.calendar) {
    pieceQuery.$and = [
      f.calendar === 'sm' ? { $or: [{ calendar: 'sm' }, { calendar: null }, { calendar: '' }, { calendar: { $exists: false } }] } : { calendar: f.calendar },
    ];
  }
  const pieces = await ContentPiece.find(pieceQuery)
    .select('topic contentType calendar publishedAt liveUrl needsScript needsShoot needsContent')
    .lean();

  const needle = f.q.toLowerCase();
  const rows = [];
  for (const piece of pieces) {
    const step = postByPiece.get(String(piece._id));
    const postedAt = piece.publishedAt || step?.postedAt || null;
    if (!postedAt) continue;
    if (f.month && (istDateKey(postedAt) || '').slice(0, 7) !== f.month) continue;
    if (f.workflow && workflowFromFlags(piece.contentType, piece) !== f.workflow) continue;
    if (needle && !String(piece.topic || '').toLowerCase().includes(needle)) continue;
    rows.push({ piece, postedAt: new Date(postedAt), liveUrl: piece.liveUrl || step?.publishedUrl || '' });
  }
  rows.sort((a, b) => b.postedAt - a.postedAt || String(b.piece._id).localeCompare(String(a.piece._id)));

  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / f.limit));
  const slice = rows.slice((f.page - 1) * f.limit, f.page * f.limit);

  // Credits: each finished step and its owner's name.
  const steps = slice.length
    ? await WorkItem.find({ contentPieceId: { $in: slice.map((r) => r.piece._id) }, status: { $in: FINISHED }, isSkipped: { $ne: true } })
        .select('contentPieceId stageKey stageOrder ownerId')
        .populate('ownerId', 'name')
        .sort({ stageOrder: 1 })
        .lean()
    : [];
  const creditsByPiece = new Map();
  for (const s of steps) {
    const key = String(s.contentPieceId);
    if (!creditsByPiece.has(key)) creditsByPiece.set(key, []);
    creditsByPiece.get(key).push({ step: s.stageKey, name: s.ownerId?.name || 'Unassigned' });
  }

  const previews = new Map();
  for (const { piece, liveUrl } of slice) previews.set(String(piece._id), await previewFor(piece, liveUrl, user, role));

  return {
    items: slice.map(({ piece, postedAt, liveUrl }) => ({
      id: String(piece._id),
      title: piece.topic || '',
      type: piece.contentType || '',
      workflow: workflowFromFlags(piece.contentType, piece) || null,
      workflowLabel: workflowLabel(piece.contentType, piece),
      calendar: piece.calendar || 'sm',
      postedAt,
      liveUrl,
      embed: toEmbed(liveUrl),
      // What the card shows: the live post when it embeds, else the approved final output.
      preview: previews.get(String(piece._id)),
      credits: creditsByPiece.get(String(piece._id)) || [],
    })),
    total,
    page: f.page,
    pages,
    limit: f.limit,
    filters: { month: f.month, calendar: f.calendar, type: f.type, workflow: f.workflow, q: f.q },
  };
}

const isReel = (piece) => piece.contentType === 'Reel';
/** Drive files have no shape of their own: a reel plays upright, a design shows as a post. */
const withAspect = (embed, piece) => (embed.kind === 'drive' ? { ...embed, aspect: isReel(piece) ? '9:16' : '4:5' } : embed);

/**
 * The card preview. The live post when it embeds; otherwise the piece's approved final
 * output (Edit for reels, Design for posts, its first Drive file) when the viewer may see it
 * under the Phase 3 rules: leadership always, a worker only for their own step or a step
 * before their furthest one. "Open original" keeps pointing to the live link.
 */
async function previewFor(piece, liveUrl, user, role) {
  const live = toEmbed(liveUrl);
  if (live.kind !== 'link') return { source: 'live', embed: withAspect(live, piece) };
  const finalStage = isReel(piece) ? 'Edit' : 'Design';
  const step = await WorkItem.findOne({ contentPieceId: piece._id, stageKey: finalStage, isSkipped: { $ne: true } })
    .select('_id ownerId stageOrder status stageKey')
    .lean();
  if (!step) return { source: 'live', embed: live };
  if (isWorker(role)) {
    const userId = String(user._id || user.userId || user.id || '');
    const owned = await WorkItem.find({ contentPieceId: piece._id, ownerId: userId }).select('stageOrder').lean();
    const orders = owned.map((s) => s.stageOrder || 0);
    if (!canSeeStepOutput(step, { userId, latestOwnedOrder: orders.length ? Math.max(...orders) : null })) return { source: 'live', embed: live };
  }
  const output = await approvedOutputOf(step);
  const file = outputItems(output).find((i) => i.kind === 'drive' && toEmbed(i.url).kind === 'drive');
  if (!file) return { source: 'live', embed: live };
  return { source: 'final', label: isReel(piece) ? 'Final video' : 'Final design', embed: withAspect(toEmbed(file.url), piece) };
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.statusCode = status;
  error.code = code;
  return error;
}

/**
 * Edit live link (SM Manager and admin): correct a posted piece's live link. Same rule as
 * posting; updates the piece's liveUrl and its Post step's publishedUrl together, keeps the
 * posted date, and logs the old and new link on the Post step.
 */
export async function editLiveLink(pieceId, body, user) {
  const role = normalizeRole(user.role);
  if (role !== 'sm_manager' && role !== 'admin') {
    throw httpError(403, 'FORBIDDEN_ROLE', 'Only an SM Manager or an Admin can edit a live link.');
  }
  if (!mongoose.isValidObjectId(pieceId)) throw httpError(404, 'NOT_FOUND', 'Content piece not found');
  const next = typeof body?.liveUrl === 'string' ? body.liveUrl.trim() : '';
  const problem = livePostUrlError(next);
  if (problem) {
    const error = httpError(400, 'INVALID_LIVE_URL', problem);
    error.details = { field: 'liveUrl' };
    throw error;
  }
  const piece = await ContentPiece.findById(pieceId).select('liveUrl publishedAt topic').lean();
  if (!piece) throw httpError(404, 'NOT_FOUND', 'Content piece not found');
  const step = await WorkItem.findOne({ contentPieceId: piece._id, stageKey: 'Post' }).select('_id publishedUrl postedAt status').lean();
  if (!piece.publishedAt && !step?.postedAt) throw httpError(409, 'NOT_POSTED', 'This piece has not been posted yet. Mark the Post step as posted first.');
  const previous = piece.liveUrl || step?.publishedUrl || '';
  if (previous === next && (!step || step.publishedUrl === next)) return { liveUrl: next, changed: false };

  await ContentPiece.updateOne({ _id: piece._id }, { $set: { liveUrl: next } });
  if (step) await WorkItem.updateOne({ _id: step._id }, { $set: { publishedUrl: next } });
  await logActivity({
    entityType: step ? 'work_item' : 'content_piece',
    entityId: step ? step._id : piece._id,
    actor: user,
    action: 'live_link.changed',
    metadata: { contentPieceId: piece._id, topic: piece.topic, from: previous, to: next },
  });
  return { liveUrl: next, changed: true };
}
