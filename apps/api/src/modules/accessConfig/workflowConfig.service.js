import mongoose from 'mongoose';
import { CALENDAR_KEYS, ROLE_KEYS, WORKFLOW_SLOTS, defaultWorkflowConfig } from '@mmp/shared';
import { Person } from '../people/model.js';
import { WorkflowConfig } from './workflowConfig.model.js';
import { AccessChange } from './accessChange.model.js';
import { sendAccessChanged } from './personAccess.service.js';
import { clearAccessCache, getWorkflowConfig } from '../../lib/accessResolver.js';

/**
 * Changing a calendar's reviewers, plan approvers, posters or fallback approvers (Phase C4; the
 * Phase D admin page calls it). Saves (version bump), records each slot in the AccessChange
 * history, clears the resolver cache, and sends `access:changed` to everyone in the old or new
 * lists, so their menus and buttons follow without signing out. No sockets are closed.
 */

function badRequest(message, field) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  error.details = { field };
  return error;
}

function cleanAudience(a, slot) {
  const roles = [...new Set((a?.roles || []).map(String))];
  const badRoles = roles.filter((r) => !ROLE_KEYS.includes(r));
  if (badRoles.length) throw badRequest(`Unknown role in ${slot}: ${badRoles.join(', ')}`, slot);
  const userIds = [...new Set((a?.userIds || []).map(String))];
  if (userIds.some((id) => !mongoose.isValidObjectId(id))) throw badRequest(`Invalid person in ${slot}`, slot);
  return { roles, userIds };
}

/** Everyone an audience names (active or not): by role and by id. */
async function peopleIn(audiences) {
  const roles = [...new Set(audiences.flatMap((a) => a.roles || []))];
  const ids = [...new Set(audiences.flatMap((a) => (a.userIds || []).map(String)))];
  if (!roles.length && !ids.length) return [];
  const or = [];
  if (roles.length) or.push({ role: { $in: roles } });
  if (ids.length) or.push({ _id: { $in: ids } });
  return Person.find({ $or: or }).select('_id').lean();
}

export async function updateWorkflowConfig(calendar, changes = {}, actor = null, { note = '' } = {}) {
  if (!CALENDAR_KEYS.includes(calendar)) throw badRequest(`Unknown calendar: ${calendar}`, 'calendar');
  const current = await getWorkflowConfig(calendar);
  const next = { ...current };
  const changedSlots = [];
  for (const slot of WORKFLOW_SLOTS) {
    if (!(slot in changes)) continue;
    const value = cleanAudience(changes[slot], slot);
    if (JSON.stringify(value) !== JSON.stringify(cleanAudience(current[slot], slot))) {
      next[slot] = value;
      changedSlots.push(slot);
    }
  }
  if (!changedSlots.length) return current;

  const actorId = actor?._id || actor?.id || actor?.userId || null;
  let doc = await WorkflowConfig.findOne({ calendar });
  if (!doc) {
    const d = defaultWorkflowConfig(calendar);
    doc = new WorkflowConfig({ calendar, reviewers: d.reviewers, planApprovers: d.planApprovers, posters: d.posters, fallbackApprovers: d.fallbackApprovers });
  }
  for (const slot of changedSlots) doc[slot] = next[slot];
  doc.updatedBy = actorId;
  await doc.save();
  clearAccessCache();

  await AccessChange.insertMany(
    changedSlots.map((slot) => ({ actorId, entityType: 'workflow_config', entityId: calendar, field: slot, before: current[slot], after: next[slot], note }))
  );
  const affected = await peopleIn(changedSlots.flatMap((slot) => [current[slot], next[slot]]));
  sendAccessChanged(affected.map((p) => p._id));
  return getWorkflowConfig(calendar);
}
