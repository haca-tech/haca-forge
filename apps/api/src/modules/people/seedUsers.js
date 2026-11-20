/**
 * The local test users (Phase 9, roles updated in Phase 12b). No passwords here: each password
 * comes from the git-ignored apps/api/.env as SEED_PASSWORD_<KEY>. Used only by
 * scripts/reset-and-seed.js; the app never creates or rewrites these users at startup.
 *
 * The keys are unchanged from Phase 9 so the existing .env entries keep working; the roles
 * follow the Phase 12b model (CREATIVEHEAD is now the Creative Lead, EXECUTIVE the read-only
 * Creative Head, and the workers are role "executive"). PRODUCTIONHEAD and GROWTHLEAD are
 * optional: they are seeded only when their passwords are set.
 */
export const SEED_USERS = [
  // The Creative Lead reads SEED_PASSWORD_CREATIVELEAD when it is set (its role's name), else the older SEED_PASSWORD_CREATIVEHEAD.
  { key: 'CREATIVEHEAD', passwordKeys: ['CREATIVELEAD', 'CREATIVEHEAD'], name: 'Test Creative Lead', email: 'creativelead@demo.haca.local', phone: '9000000001', role: 'creative_lead', jobRole: 'Creative Manager (TL)', departmentCode: 'design', workPreferences: [], capacity: 40 },
  { key: 'SMMANAGER', name: 'Test SM Manager', email: 'smmanager@demo.haca.local', phone: '9000000002', role: 'sm_manager', jobRole: 'Social Media Manager', departmentCode: 'social_media', workPreferences: [], capacity: 40 },
  { key: 'EXECUTIVE', name: 'Test Creative Head', email: 'creativehead@demo.haca.local', phone: '9000000003', role: 'creative_head', jobRole: '', departmentCode: null, workPreferences: [], capacity: 0 },
  { key: 'WRITER1', name: 'Test Writer One', email: 'writer1@demo.haca.local', phone: '9000000011', role: 'executive', jobRole: 'Writer', departmentCode: 'seo_content', workPreferences: ['Content', 'Script'], capacity: 40 },
  { key: 'WRITER2', name: 'Test Writer Two', email: 'writer2@demo.haca.local', phone: '9000000012', role: 'executive', jobRole: 'Writer', departmentCode: 'seo_content', workPreferences: ['Content', 'Script'], capacity: 40 },
  { key: 'DESIGNER1', name: 'Test Designer One', email: 'designer1@demo.haca.local', phone: '9000000013', role: 'executive', jobRole: 'Graphic Designer', departmentCode: 'design', workPreferences: ['Design'], capacity: 40 },
  { key: 'DESIGNER2', name: 'Test Designer Two', email: 'designer2@demo.haca.local', phone: '9000000014', role: 'executive', jobRole: 'Graphic Designer', departmentCode: 'design', workPreferences: ['Design'], capacity: 40 },
  { key: 'SHOOTER', name: 'Test Cinematographer', email: 'shooter@demo.haca.local', phone: '9000000015', role: 'executive', jobRole: 'Cinematographer', departmentCode: 'video_production', workPreferences: ['Shoot'], capacity: 40 },
  { key: 'EDITOR1', name: 'Test Editor One', email: 'editor1@demo.haca.local', phone: '9000000016', role: 'executive', jobRole: 'Video Editor', departmentCode: 'video_production', workPreferences: ['Edit'], capacity: 40 },
  { key: 'EDITOR2', name: 'Test Editor Two', email: 'editor2@demo.haca.local', phone: '9000000017', role: 'executive', jobRole: 'Video Editor', departmentCode: 'video_production', workPreferences: ['Edit'], capacity: 40 },
  // Post belongs to SM Managers now: the former poster account is a worker with no job role yet.
  { key: 'POSTER', name: 'Test Poster', email: 'poster@demo.haca.local', phone: '9000000018', role: 'executive', jobRole: '', departmentCode: 'social_media', workPreferences: [], capacity: 40 },
  { key: 'ALLROUNDER', name: 'Test All Rounder', email: 'allrounder@demo.haca.local', phone: '9000000019', role: 'executive', jobRole: 'All Rounder', departmentCode: 'social_media', workPreferences: ['Script', 'Content', 'Shoot', 'Design', 'Edit'], capacity: 40 },
  { key: 'PRODUCTIONHEAD', name: 'Test Production Head', email: 'productionhead@demo.haca.local', phone: '9000000004', role: 'production_head', jobRole: '', departmentCode: null, workPreferences: [], capacity: 0, optional: true },
  { key: 'GROWTHLEAD', name: 'Test Growth Lead', email: 'growthlead@demo.haca.local', phone: '9000000005', role: 'growth_lead', jobRole: '', departmentCode: 'performance_marketing', workPreferences: [], capacity: 40, optional: true },
];

const isSet = (source, name) => Boolean(source?.[name]) && String(source[name]).length >= 8;

/** The env variable holding this user's password: the first of its keys that is set (else its own key's name). */
export const seedPasswordVar = (user, source = process.env) => {
  const names = (user.passwordKeys || [user.key]).map((k) => `SEED_PASSWORD_${k}`);
  return names.find((n) => isSet(source, n)) || `SEED_PASSWORD_${user.key}`;
};

const hasPassword = (source, user) => isSet(source, seedPasswordVar(user, source));

/** The env variable names the reset script needs, and which of them are missing (optional users excluded). */
export function missingSeedPasswords(source = process.env) {
  return SEED_USERS.filter((u) => !u.optional && !hasPassword(source, u)).map((u) => seedPasswordVar(u, source));
}

/** The users to seed: every required one, plus each optional one whose password is set. */
export function seedUsersToCreate(source = process.env) {
  return SEED_USERS.filter((u) => !u.optional || hasPassword(source, u));
}
