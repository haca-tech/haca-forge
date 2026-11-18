import { describe, it, expect } from 'vitest';
import { ROLE_PERMISSIONS, ROLE_KEYS, PERMISSION_KEYS, ROLE_LABELS } from '@mmp/shared';
import { defineAbilityForUser } from '../src/lib/permissions.js';

describe('Marketing OS Permissions & CASL Ability Tests (R2 Canonical 5 Roles)', () => {
  it('should have exactly the 7 Phase 12b role keys', () => {
    expect(ROLE_KEYS).toEqual(['admin', 'creative_head', 'production_head', 'creative_lead', 'growth_lead', 'sm_manager', 'executive']);
  });

  it('should export ROLE_LABELS for every role', () => {
    expect(ROLE_LABELS).toEqual({
      admin: 'Admin',
      creative_head: 'Creative Head',
      production_head: 'Production Head',
      creative_lead: 'Creative Lead',
      growth_lead: 'Growth Lead',
      sm_manager: 'SM Manager',
      executive: 'Executive',
    });
  });

  it('admin holds all permission keys derived dynamically from PERMISSION_KEYS', () => {
    expect(ROLE_PERMISSIONS.admin).toEqual([...PERMISSION_KEYS]);
    expect(ROLE_PERMISSIONS.admin).toContain('portal.view');
    expect(ROLE_PERMISSIONS.admin).toContain('people.view');
    expect(ROLE_PERMISSIONS.admin).toContain('user.approve');
    expect(ROLE_PERMISSIONS.admin).toContain('user.manage');
    expect(ROLE_PERMISSIONS.admin).toContain('people.assign');
    expect(ROLE_PERMISSIONS.admin).toContain('calendar.plan');
    expect(ROLE_PERMISSIONS.admin).toContain('calendar.approve');
  });

  it('creative_lead and growth_lead hold the approver permissions snapshot (both calendars in Phase 12b)', () => {
    const expectedLeadPerms = [
      'portal.view',
      'people.view',
      'people.assign',
      'calendar.approve',
      'feedback.give',
      'feedback.respond',
      'revision.classify',
      'assignment.override',
      'work.update.own',
      'analytics.team',
      'report.view',
      'chat.use',
      'chat.group.create',
      'chat.moderate',
      'team.profile.view',
    ];
    expect(ROLE_PERMISSIONS.creative_lead).toEqual(expectedLeadPerms);
    expect(ROLE_PERMISSIONS.growth_lead).toEqual(expectedLeadPerms);
    for (const key of ['user.manage', 'user.approve', 'calendar.plan', 'work.create', 'report.configure', 'automation.manage']) {
      expect(ROLE_PERMISSIONS.creative_lead).not.toContain(key);
    }
  });

  it('creative_head and production_head are read-only: view keys and zero write keys', () => {
    const viewerPerms = ['portal.view', 'people.view', 'analytics.team', 'report.view', 'chat.read', 'team.profile.view'];
    expect(ROLE_PERMISSIONS.creative_head).toEqual(viewerPerms);
    expect(ROLE_PERMISSIONS.production_head).toEqual(viewerPerms);
    for (const key of ['work.create', 'work.request', 'work.update.own', 'calendar.plan', 'calendar.approve', 'feedback.give', 'feedback.respond', 'chat.use', 'assignment.override', 'people.assign']) {
      expect(ROLE_PERMISSIONS.creative_head).not.toContain(key);
    }
  });

  it('executive (workers) has personal work permissions only, exactly as team_member had', () => {
    expect(ROLE_PERMISSIONS.executive).toEqual(['work.update.own', 'work.request', 'feedback.respond', 'chat.use']);
    expect(ROLE_PERMISSIONS.team_member).toBeUndefined();
  });

  it('report.configure and automation.manage are admin only', () => {
    for (const key of ['report.configure', 'automation.manage']) {
      expect(ROLE_KEYS.filter((r) => ROLE_PERMISSIONS[r].includes(key))).toEqual(['admin']);
    }
  });

  it('admin should have full ability to manage all in CASL', () => {
    const adminUser = { role: 'admin', status: 'active' };
    const ability = defineAbilityForUser(adminUser);
    expect(ability.can('manage', 'all')).toBe(true);
    expect(ability.can('user.approve', 'all')).toBe(true);
    expect(ability.can('user.manage', 'all')).toBe(true);
  });

  it('suspended user should have zero permissions in CASL', () => {
    const suspendedAdmin = { role: 'admin', status: 'suspended' };
    const ability = defineAbilityForUser(suspendedAdmin);
    expect(ability.can('manage', 'all')).toBe(false);
    expect(ability.can('user.manage', 'all')).toBe(false);
    expect(ability.can('work.create', 'all')).toBe(false);
  });
});
