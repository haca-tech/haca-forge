import { storageKeyOf } from '@mmp/shared';

/**
 * Model helpers (no settings, no driver): file fields store a storage key. A setter turns a value
 * sent back as "/uploads/..." or as a signed file URL into its key; anything else is kept.
 * Mongoose also runs setters on query filters, so look files up with fileRefFilter(key), which
 * matches both the key and an older "/uploads/..." value.
 */
export const toStoredFile = (value) => (typeof value === 'string' ? storageKeyOf(value) ?? value : value);

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const fileRefFilter = (key) => new RegExp(`^/?${escapeRegExp(String(key).replace(/^\//, ''))}$`);
