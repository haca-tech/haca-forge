// Simple workload (step counts): the shared workloadFor, bands and pickOwner.
import { describe, it, expect } from 'vitest';
import {
  workloadFor,
  workloadBand,
  activeStepLimitOf,
  ownerHasWork,
  pickOwner,
  withPlannedStep,
  targetWindow,
  DEFAULT_ACTIVE_STEP_LIMIT,
} from '@mmp/shared';

// 20 Nov 2026, 00:30 IST (19 Nov 19:00 UTC): the IST day is already the 20th.
const NOW = new Date('2026-11-19T19:00:00.000Z');
/** Noon IST on today + n days. */
const day = (n) => new Date(Date.UTC(2026, 10, 20 + n, 6, 30)).toISOString();
const step = (over = {}) => ({ status: 'Not Started', isLocked: false, dueDate: day(1), ...over });

describe('workloadFor', () => {
  it('counts only steps the owner has to act on', () => {
    const steps = [
      step({ status: 'Not Started' }), // counted
      step({ status: 'Not Started', isLocked: true }), // locked: no
      step({ status: 'In Progress' }), // counted
      step({ status: 'In Progress', pauseState: 'paused' }), // paused: counted
      step({ status: 'In Progress', latestVersionStatus: 'changes_requested', revisions: 1 }), // rework: counted
      step({ status: 'Blocked' }), // counted
      step({ status: 'Feedback', latestVersionStatus: 'submitted' }), // waiting for review: no
      step({ status: 'Feedback', latestVersionStatus: 'changes_requested', revisions: 1 }), // changes requested: counted
      step({ status: 'Pending' }), // no
      step({ status: 'Approved' }), // no
      step({ status: 'Published' }), // no
      step({ status: 'In Progress', isSkipped: true }), // skipped: no
    ];
    const w = workloadFor({}, steps, NOW);
    expect(w.dueThisWeek).toBe(6);
    expect(w.inProgress).toBe(3);
  });

  it('a step waiting for review is not counted; a changes-requested step is', () => {
    const waiting = step({ status: 'Feedback', latestVersionStatus: 'submitted' });
    const sentBack = step({ status: 'Feedback', latestVersionStatus: 'changes_requested', revisions: 1 });
    expect(ownerHasWork(waiting)).toBe(false);
    expect(ownerHasWork(sentBack)).toBe(true);
    expect(workloadFor({}, [waiting], NOW).dueThisWeek).toBe(0);
    expect(workloadFor({}, [sentBack], NOW).dueThisWeek).toBe(1);
  });

  it('overdue steps count; the window is today to today + 6 in IST', () => {
    const w = workloadFor({}, [step({ dueDate: day(-10) }), step({ dueDate: day(0) }), step({ dueDate: day(6) }), step({ dueDate: day(7) })], NOW);
    expect(w.dueThisWeek).toBe(3);
    // IST boundary: 26 Nov 23:30 IST is inside, 27 Nov 00:30 IST is outside.
    expect(workloadFor({}, [step({ dueDate: '2026-11-26T18:00:00.000Z' })], NOW).dueThisWeek).toBe(1);
    expect(workloadFor({}, [step({ dueDate: '2026-11-26T19:00:00.000Z' })], NOW).dueThisWeek).toBe(0);
    // `deadline` is used when there is no dueDate; no date at all is not due.
    expect(workloadFor({}, [{ status: 'In Progress', deadline: day(2) }, { status: 'In Progress' }], NOW)).toMatchObject({ dueThisWeek: 1, inProgress: 2 });
  });

  it('nextDue is the earliest due date the owner has to act on', () => {
    const w = workloadFor({}, [step({ dueDate: day(9) }), step({ status: 'Pending', dueDate: day(-3) }), step({ dueDate: day(-1) })], NOW);
    expect(w.nextDue).toBe('2026-11-19');
    expect(workloadFor({}, [], NOW).nextDue).toBeNull();
  });
});

describe('bands and limits', () => {
  it('default limit 4: Available up to 2, Busy 3 to 4, Over above', () => {
    expect(DEFAULT_ACTIVE_STEP_LIMIT).toBe(4);
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => workloadBand(n))).toEqual(['Available', 'Available', 'Available', 'Busy', 'Busy', 'Over', 'Over']);
  });

  it('custom limits', () => {
    expect([5, 6, 7].map((n) => workloadBand(n, 6))).toEqual(['Busy', 'Busy', 'Over']);
    // A limit below 3: over the limit wins.
    expect([2, 3].map((n) => workloadBand(n, 2))).toEqual(['Available', 'Over']);
    expect(workloadBand(2, 1)).toBe('Over');
    const five = Array.from({ length: 5 }, () => step());
    expect(workloadFor({ activeStepLimit: 6 }, five, NOW)).toMatchObject({ dueThisWeek: 5, limit: 6, band: 'Busy' });
    expect(workloadFor({}, five, NOW)).toMatchObject({ limit: 4, band: 'Over' });
  });

  it('an invalid limit falls back to the default', () => {
    expect([undefined, null, 0, -1, 2.5, 'x'].map((v) => activeStepLimitOf({ activeStepLimit: v }))).toEqual([4, 4, 4, 4, 4, 4]);
    expect(activeStepLimitOf({ activeStepLimit: 7 })).toBe(7);
  });
});

describe('pickOwner', () => {
  const person = (id, name, steps = [], extra = {}) => ({ id, name, steps, ...extra });

  it('fewest due in the window, then fewest in progress, then name, then id', () => {
    const a = person('a', 'Asha', [step(), step()]);
    const b = person('b', 'Bilal', [step()]);
    expect(pickOwner([a, b], { now: NOW }).candidate.id).toBe('b');
    // Equal due: fewer in progress wins.
    const c = person('c', 'Chitra', [step({ status: 'In Progress' })]);
    const d = person('d', 'Dev', [step({ status: 'Not Started' })]);
    expect(pickOwner([c, d], { now: NOW }).candidate.id).toBe('d');
    // All equal: name (case-insensitive), then id.
    expect(pickOwner([person('2', 'esha'), person('1', 'Esha'), person('3', 'Asha')], { now: NOW }).candidate.id).toBe('3');
    expect(pickOwner([person('2', 'esha'), person('1', 'Esha')], { now: NOW }).candidate.id).toBe('1');
  });

  it('only eligible people; null when nobody is', () => {
    const a = person('a', 'Asha', [], { steps_: ['Script'] });
    const b = person('b', 'Bilal', [step(), step(), step()]);
    expect(pickOwner([a, b], { now: NOW, eligible: (c) => c.id === 'b' }).candidate.id).toBe('b');
    expect(pickOwner([a, b], { now: NOW, eligible: () => false })).toBeNull();
    expect(pickOwner([], { now: NOW })).toBeNull();
  });

  it('counts the target step\'s own 7-day window', () => {
    // Asha is busy this week, free in three weeks; Bilal the other way round.
    const asha = person('a', 'Asha', [step({ dueDate: day(1) }), step({ dueDate: day(2) })]);
    const bilal = person('b', 'Bilal', [step({ dueDate: day(20) })]);
    expect(pickOwner([asha, bilal], { now: NOW, targetDue: day(3) }).candidate.id).toBe('b');
    expect(pickOwner([asha, bilal], { now: NOW, targetDue: day(21) }).candidate.id).toBe('a');
    // A later window does not count overdue work; this week does.
    expect(targetWindow(day(21), NOW)).toMatchObject({ startKey: '2026-12-05', endKey: '2026-12-11', thisWeek: false });
    expect(targetWindow(null, NOW)).toMatchObject({ startKey: '2026-11-20', endKey: '2026-11-26', thisWeek: true });
  });

  it('spreads work across a run', () => {
    let team = [person('a', 'Asha'), person('b', 'Bilal'), person('c', 'Chitra')];
    const picks = [];
    for (let i = 0; i < 6; i++) {
      const p = pickOwner(team, { now: NOW, targetDue: day(2) });
      picks.push(p.candidate.id);
      team = team.map((c) => (c.id === p.candidate.id ? withPlannedStep(c, day(2)) : c));
    }
    expect(picks).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('an over-limit pick is still made, with a warning', () => {
    const full = (id, name) => person(id, name, [step(), step(), step(), step()]);
    const p = pickOwner([full('x', 'Ashwin Kumar'), full('y', 'Zara')], { now: NOW, targetDue: day(1) });
    expect(p.candidate.id).toBe('x');
    expect(p.overLimit).toBe(true);
    expect(p.warning).toBe('Over limit: Ashwin has 5 due this week.');
    // A custom limit: 4 due + this one is within 6.
    const roomy = pickOwner([person('r', 'Ravi', [step(), step(), step(), step()], { activeStepLimit: 6 })], { now: NOW });
    expect(roomy).toMatchObject({ overLimit: false, warning: null, limit: 6 });
    expect(roomy.reason).toBe('Fewest due this week (4), 0 in progress');
  });

  it('revision counts and ratings make no difference', () => {
    const a = person('a', 'Asha', [step({ revisions: 9 })], { revisions: 40, avgRevisions: 6, rating: 1 });
    const b = person('b', 'Bilal', [step()], { revisions: 0, avgRevisions: 0, rating: 5 });
    const plain = pickOwner([person('a', 'Asha', [step()]), person('b', 'Bilal', [step()])], { now: NOW });
    expect(pickOwner([a, b], { now: NOW }).candidate.id).toBe(plain.candidate.id);
    expect(pickOwner([b, a], { now: NOW }).candidate.id).toBe('a');
  });
});
