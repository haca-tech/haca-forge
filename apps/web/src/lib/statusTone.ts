import { ROLE_KEYS } from '@mmp/shared';
/**
 * Maps raw step statuses and roles to the shared CSS tone classes in index.css
 * (`.status-*`, `.role-*`). Colours live only in the stylesheet; this file only
 * names the tone, so every screen shows a status the same way.
 *
 * Raw status → user-facing label (see getStepStatusLabel in @mmp/shared):
 *   Not Started → Not started        In Progress → In progress
 *   Pending     → Waiting for approval  Feedback  → Changes requested
 *   Approved    → Approved           Blocked     → Blocked
 *   Published   → Posted             isLocked    → Locked
 */
export type StatusTone =
  | 'locked'
  | 'not-started'
  | 'in-progress'
  | 'waiting'
  | 'changes'
  | 'approved'
  | 'blocked'
  | 'posted';

export function statusTone(status?: string | null, isLocked?: boolean): StatusTone {
  if (isLocked) return 'locked';
  switch (status) {
    case 'In Progress':
      return 'in-progress';
    case 'Pending':
      return 'waiting';
    case 'Feedback':
      return 'changes';
    case 'Approved':
      return 'approved';
    case 'Blocked':
      return 'blocked';
    case 'Published':
      return 'posted';
    default:
      return 'not-started';
  }
}

/** Class for a status tone, e.g. `status-in-progress`. Combine with `status-chip`, `status-dot` or `status-tint`. */
export const statusClass = (tone: StatusTone): string => `status-${tone}`;

/** Class for a role tone, e.g. `role-creative-lead`. Combine with `role-badge`. */
export function roleClass(role?: string | null): string {
  return role && (ROLE_KEYS as readonly string[]).includes(role) ? `role-${role.replace(/_/g, '-')}` : 'role-executive';
}

/** Workload band -> shared class (`band-healthy` | `band-high` | `band-overloaded`).
 *  Combine with `band-chip`, `band-tint` or `band-bar`. Bands come from step counts:
 *  Available (2 or fewer due this week), Busy (up to the person's limit), Over (above it). */
export function bandClass(band?: string | null): string {
  switch (band) {
    case 'Over':
      return 'band-overloaded';
    case 'Busy':
      return 'band-high';
    default:
      return 'band-healthy';
  }
}

/**
 * The status a list should show for a step. 'Feedback' is saved both for a submitted step and
 * for one that was sent back; the API marks the first kind with `awaitingReview`, and it is
 * shown as Pending ("Waiting for approval"). Everything else is shown as saved.
 */
export function displayStatus(step?: { status?: string | null; awaitingReview?: boolean } | null): string {
  if (!step) return '';
  return step.awaitingReview && step.status === 'Feedback' ? 'Pending' : step.status || '';
}

/** A copy of the step with its display status, for read-only lists. */
export function withDisplayStatus<T extends { status?: string | null; awaitingReview?: boolean }>(step: T): T {
  return step && step.awaitingReview && step.status === 'Feedback' ? { ...step, status: 'Pending' } : step;
}
