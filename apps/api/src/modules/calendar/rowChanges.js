import {
  DELIVERABLE_TYPE_KEYS,
  PLAN_ROW_SUGGESTION_FIELDS,
  normalizeRole,
  planMonthKey,
  workflowFromFlags,
} from '@mmp/shared';
import { CalendarPlan } from './plan.model.js';
import { ContentPiece } from './contentPiece.model.js';
import { parseGridRowInput, saveGridRows, ymdInAppTz } from './planGrid.service.js';
import { logRowHistory, rowHistory } from './rowHistory.js';

/**
 * Phase 13: a lead's change request on a plan row. The lead writes a message and may suggest
 * new values (posting date, topic, type and workflow, brief); the SM Manager applies the
 * suggestion (or edits by hand) and resubmits. Suggestions are checked with the grid's own
 * parser, so they are values the row could actually take.
 */

function httpError(status, code, message, extra = {}) {
  const error = new Error(message);
  error.statusCode = status;
  error.code = code;
  Object.assign(error, extra);
  return error;
}

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** The row's current value of each suggestion field, in the same shape as a suggestion. */
export function currentRowValues(row) {
  return {
    postingDate: ymdInAppTz(row.postingDate),
    topic: row.topic || '',
    type: row.contentType || '',
    workflow: workflowFromFlags(row.contentType, row) || '',
    brief: row.brief || '',
  };
}

function inPlanPeriod(plan, ymd) {
  if (!ymd) return false;
  if ((plan.kind || 'monthly') === 'monthly' && plan.periodStart) return ymd.slice(0, 7) === planMonthKey(plan.periodStart);
  const from = ymdInAppTz(plan.periodStart);
  const to = ymdInAppTz(plan.periodEnd);
  return (!from || ymd >= from) && (!to || ymd <= to);
}

/**
 * Check a lead's suggested values for one row. Returns the cleaned suggestions (only the
 * fields that differ from the row now), or null when nothing is suggested. Throws 400
 * INVALID_SUGGESTION with per-field messages: the date must be in the plan's month and the
 * type and workflow must be a valid pair.
 */
export function normalizeSuggestions(row, plan, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cells = {};
  for (const k of PLAN_ROW_SUGGESTION_FIELDS) {
    if (str(raw[k]) !== '') cells[k] = str(raw[k]);
  }
  if (Object.keys(cells).length === 0) return null;
  if (cells.type) cells.typeExact = DELIVERABLE_TYPE_KEYS.includes(cells.type);

  const month = plan.periodStart ? planMonthKey(plan.periodStart) : undefined;
  const { errors, draft } = parseGridRowInput(cells, row, [], { month });
  const fieldErrors = {};
  for (const k of PLAN_ROW_SUGGESTION_FIELDS) {
    if (cells[k] !== undefined && errors[k]) fieldErrors[k] = errors[k];
  }
  if (cells.postingDate && !fieldErrors.postingDate && !inPlanPeriod(plan, draft.postingDate)) {
    fieldErrors.postingDate = ['Suggest a date inside the plan month.'];
  }
  if (Object.keys(fieldErrors).length) {
    throw httpError(400, 'INVALID_SUGGESTION', Object.values(fieldErrors)[0][0], { details: { rowId: String(row._id), fields: fieldErrors } });
  }

  const next = {
    postingDate: draft.postingDate,
    topic: draft.topic,
    type: draft.type,
    workflow: workflowFromFlags(draft.type, draft) || '',
    brief: draft.brief,
  };
  const now = currentRowValues(row);
  const out = {};
  for (const k of PLAN_ROW_SUGGESTION_FIELDS) {
    // A type change resets the workflow; the new workflow is part of the suggestion then.
    const asked = cells[k] !== undefined || (k === 'workflow' && cells.type !== undefined && next.workflow);
    if (asked && next[k] !== now[k]) out[k] = next[k];
  }
  return Object.keys(out).length ? out : null;
}

/** The open change request, as stored on the row. */
export function buildChangeRequest(message, suggestions, user) {
  return {
    message,
    suggestions: suggestions || undefined,
    requestedById: user._id || user.userId || null,
    requestedAt: new Date(),
  };
}

async function loadRow(planId, rowId) {
  const plan = await CalendarPlan.findById(planId).lean();
  if (!plan) throw httpError(404, 'NOT_FOUND', 'Calendar plan not found');
  const row = await ContentPiece.findOne({ _id: rowId, planId }).lean();
  if (!row) throw httpError(404, 'NOT_FOUND', 'Content piece row not found in this plan');
  return { plan, row };
}

/**
 * SM Manager (or admin) applies the lead's suggested values to a row. The values go through
 * the grid's save (same checks as typing them in); the change request is cleared, the row
 * stays "Changes requested" until it is resubmitted, and the history keeps the request.
 */
export async function applyRowSuggestion(planId, rowId, user) {
  const role = normalizeRole(user.role);
  if (role !== 'sm_manager' && role !== 'admin') {
    throw httpError(403, 'FORBIDDEN_ROLE', 'Only the SM Manager or an Admin can apply a suggestion.');
  }
  const { plan, row } = await loadRow(planId, rowId);
  if (row.rowStatus !== 'changes_requested' || !row.changeRequest) {
    throw httpError(400, 'NO_CHANGE_REQUEST', 'This row has no open change request.');
  }
  const suggestions = row.changeRequest.suggestions || {};
  const cells = {};
  for (const k of PLAN_ROW_SUGGESTION_FIELDS) {
    if (str(suggestions[k]) !== '') cells[k] = suggestions[k];
  }
  if (Object.keys(cells).length === 0) {
    throw httpError(400, 'NO_SUGGESTION', 'The lead suggested no values for this row. Edit it by hand, then resubmit.');
  }
  if (cells.type) cells.typeExact = DELIVERABLE_TYPE_KEYS.includes(cells.type);

  const before = currentRowValues(row);
  const result = await saveGridRows(
    { calendar: plan.calendar || 'sm', month: planMonthKey(plan.periodStart), planId: String(plan._id), rows: [{ rowId: String(row._id), cells }] },
    user
  );
  const r = result.results[0];
  if (!r || r.status !== 'saved') {
    const fields = r?.cellErrors || {};
    const first = Object.values(fields)[0]?.[0] || 'The suggestion could not be applied.';
    throw httpError(400, 'SUGGESTION_NOT_APPLIED', first, { details: { fields } });
  }
  await ContentPiece.updateOne({ _id: row._id }, { $set: { changeRequest: null } });
  const applied = {};
  for (const k of Object.keys(cells)) if (k !== 'typeExact') applied[k] = suggestions[k];
  await logRowHistory(row._id, user, 'row.suggestion_applied', {
    planId: plan._id,
    topic: row.topic,
    message: row.changeRequest.message,
    suggestions,
    applied,
    before,
  });
  return { row: r.row || null };
}

/** The row's history: change requests, applied suggestions, resubmits, approvals. */
export async function getRowHistory(planId, rowId) {
  await loadRow(planId, rowId);
  return rowHistory(rowId);
}
