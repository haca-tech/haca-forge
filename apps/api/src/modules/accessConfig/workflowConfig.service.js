import mongoose from 'mongoose';
import { CALENDAR_KEYS, ROLE_KEYS, WORKFLOW_SLOTS, defaultWorkflowConfig, slotEligibleRole } from '@mmp/shared';
import { Person } from '../people/model.js';
import { WorkflowConfig } from './workflowConfig.model.js';
import { AccessChange } from './accessChange.model.js';
import { sendAccessChanged } from './personAccess.service.js';
import { clearAccessCache, getWorkflowConfig, readWorkflowConfigFresh } from '../../lib/accessResolver.js';

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

function cleanAudience(a, slot, { strict = false } = {}) {
  const roles = [...new Set((a?.roles || []).map(String))];
  const badRoles = roles.filter((r) => !ROLE_KEYS.includes(r));
  if (badRoles.length) throw badRequest(`Unknown role in ${slot}: ${badRoles.join(', ')}`, slot);
  // A role that can never act in the slot (the Viewer anywhere; a role without the permission).
  const ineligible = strict ? roles.filter((r) => !slotEligibleRole(r, slot)) : [];
  if (ineligible.length) throw badRequest(`This role cannot be named in ${slot}: ${ineligible.join(', ')}`, slot);
  const userIds = [...new Set((a?.userIds || []).map(String))];
  if (userIds.some((id) => !mongoose.isValidObjectId(id))) throw badRequest(`Invalid person in ${slot}`, slot);
  return { roles, userIds };
}

/** 400 for an unknown or ineligible role in any slot being changed (before any other check). */
export function assertSlotRoles(changes = {}) {
  for (const slot of WORKFLOW_SLOTS) if (slot in changes) cleanAudience(changes[slot], slot, { strict: true });
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

function settingsChanged() {
  const error = new Error('Settings changed — reload');
  error.statusCode = 409;
  error.code = 'SETTINGS_CHANGED';
  return error;
}

/**
 * Saves the given slots. Compares against the settings in the database (never the cache), and
 * writes only if the stored version is still `expectedVersion` (the version the admin page
 * showed; when omitted, the version just read), so two saves can't overwrite each other and every
 * save gets its own version number. A mismatch is 409 SETTINGS_CHANGED.
 */
export async function updateWorkflowConfig(calendar, changes = {}, actor = null, { note = '', expectedVersion } = {}) {
  if (!CALENDAR_KEYS.includes(calendar)) throw badRequest(`Unknown calendar: ${calendar}`, 'calendar');
  const current = await readWorkflowConfigFresh(calendar);
  const expected = expectedVersion === undefined || expectedVersion === null ? current.version || 0 : Number(expectedVersion);
  if (!Number.isInteger(expected) || expected < 0) throw badRequest('version must be a whole number', 'version');
  if ((current.version || 0) !== expected) throw settingsChanged();
  const next = { ...current };
  const changedSlots = [];
  for (const slot of WORKFLOW_SLOTS) {
    if (!(slot in changes)) continue;
    const value = cleanAudience(changes[slot], slot, { strict: true });
    if (JSON.stringify(value) !== JSON.stringify(cleanAudience(current[slot], slot))) {
      next[slot] = value;
      changedSlots.push(slot);
    }
  }
  if (!changedSlots.length) return current;

  const actorId = actor?._id || actor?.id || actor?.userId || null;
  const set = { updatedBy: actorId, version: expected + 1 };
  for (const slot of changedSlots) set[slot] = next[slot];
  let doc;
  if (expected === 0) {
    // No stored settings yet: the first save creates them (the unique calendar index makes a
    // concurrent first save fail instead of overwriting).
    const d = defaultWorkflowConfig(calendar);
    try {
      doc = await WorkflowConfig.create({ calendar, reviewers: d.reviewers, planApprovers: d.planApprovers, posters: d.posters, fallbackApprovers: d.fallbackApprovers, ...set });
    } catch (err) {
      if (err?.code === 11000) throw settingsChanged();
      throw err;
    }
  } else {
    doc = await WorkflowConfig.findOneAndUpdate({ calendar, version: expected }, { $set: set }, { new: true });
    if (!doc) throw settingsChanged();
  }
  clearAccessCache();

  const snapshot = (c) => Object.fromEntries(WORKFLOW_SLOTS.map((slot) => [slot, cleanAudience(c[slot], slot)]));
  await AccessChange.insertMany(
    changedSlots.map((slot) => ({
      actorId,
      entityType: 'workflow_config',
      entityId: calendar,
      field: slot,
      before: current[slot],
      after: next[slot],
      note,
      configBefore: snapshot(current),
      configAfter: snapshot(next),
      version: doc.version,
    }))
  );
  const affected = await peopleIn(changedSlots.flatMap((slot) => [current[slot], next[slot]]));
  sendAccessChanged(affected.map((p) => p._id));
  return getWorkflowConfig(calendar);
}
