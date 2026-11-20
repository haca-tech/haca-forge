import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { systemRoleOf } from '@mmp/shared';

/**
 * A CASL ability with the user's catalog-v2 permissions (`req.ability`), for code that still
 * asks `req.ability.can(key, 'all')`. The route guards use the shared resolver directly.
 */
export function defineAbilityForUser(user) {
  const { can, build } = new AbilityBuilder(createMongoAbility);
  if (!user || user.status === 'suspended') return build();
  // The locked system role (admin) holds everything.
  if (systemRoleOf(user)?.locked) can('manage', 'all');
  for (const perm of systemRoleOf(user)?.permissions || []) can(perm, 'all');
  return build();
}
