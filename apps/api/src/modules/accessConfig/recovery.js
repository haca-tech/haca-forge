import { Person } from '../people/model.js';
import { changePersonAccess } from './personAccess.service.js';

/**
 * Admin lock-out recovery (Phase E; scripts/reactivate-admin.js). Gives one existing account the
 * admin role and Active status through changePersonAccess (so it is in the History with the
 * reason "Recovery script"). Local databases only: the script checks that before calling this.
 */

/** Host(s) of a MongoDB URI; refuses SRV and anything that is not this machine. */
export function isLocalMongoUri(uri) {
  const m = /^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/.exec(String(uri || ''));
  if (!m) return false; // mongodb+srv:// and anything unparsable
  const hosts = m[1].split(',').map((h) => h.replace(/^\[|\](:\d+)?$/g, '').replace(/:\d+$/, '').toLowerCase());
  return hosts.length > 0 && hosts.every((h) => ['localhost', '127.0.0.1', '::1'].includes(h));
}

export async function planAdminRecovery(email) {
  const person = await Person.findOne({ email: String(email || '').trim().toLowerCase() });
  if (!person) return { person: null, changes: null, activeAdmins: await Person.countDocuments({ role: 'admin', status: 'active' }) };
  const changes = {};
  if (person.role !== 'admin') changes.role = 'admin';
  if (person.status !== 'active') changes.status = 'active';
  return { person, changes, activeAdmins: await Person.countDocuments({ role: 'admin', status: 'active' }) };
}

export async function applyAdminRecovery(email) {
  const { person, changes } = await planAdminRecovery(email);
  if (!person) throw new Error(`No account with the email ${email}.`);
  if (!Object.keys(changes).length) return person;
  return changePersonAccess(person, changes, null, { note: 'Recovery script (scripts/reactivate-admin.js)' });
}
