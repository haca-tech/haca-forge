import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  startScheduler,
  stopScheduler,
  isSchedulerRunning,
  getActiveJobNames,
  executeGuardedJob,
  SCHEDULED_TASKS,
  SCHEDULER_TIMEZONE,
} from '../src/lib/scheduler.js';
import { enqueueEmail } from '../src/lib/queue.js';
import * as emailModule from '../src/lib/email/index.js';
import { AUTOMATION_RULE_KEYS } from '@mmp/shared';

describe('Scheduled Automation: node-cron Scheduler Suite', () => {
  beforeEach(() => {
    stopScheduler();
  });

  afterEach(() => {
    stopScheduler();
    vi.restoreAllMocks();
  });

  it('defines exactly the 5 required automation jobs with correct schedules and Asia/Kolkata timezone', () => {
    expect(SCHEDULER_TIMEZONE).toBe('Asia/Kolkata');
    expect(SCHEDULED_TASKS).toHaveLength(5);

    const taskMap = new Map(SCHEDULED_TASKS.map((t) => [t.name, t]));

    // 1. Overdue escalation: */15 * * * *
    expect(taskMap.get('overdue_escalation')).toBeDefined();
    expect(taskMap.get('overdue_escalation').schedule).toBe('*/15 * * * *');
    expect(typeof taskMap.get('overdue_escalation').runner).toBe('function');

    // 2. Todo escalation: 0 9 * * *
    expect(taskMap.get('todo_escalation')).toBeDefined();
    expect(taskMap.get('todo_escalation').schedule).toBe('0 9 * * *');
    expect(typeof taskMap.get('todo_escalation').runner).toBe('function');

    // 3. Blocker dependency alert: 0 10 * * *
    expect(taskMap.get('blocker_dependency_alert')).toBeDefined();
    expect(taskMap.get('blocker_dependency_alert').schedule).toBe('0 10 * * *');
    expect(typeof taskMap.get('blocker_dependency_alert').runner).toBe('function');

    // 4. Revision pattern flag: 0 * * * *
    expect(taskMap.get('revision_pattern_flag')).toBeDefined();
    expect(taskMap.get('revision_pattern_flag').schedule).toBe('0 * * * *');
    expect(typeof taskMap.get('revision_pattern_flag').runner).toBe('function');

    // 5. Pause reminders: 0 * * * *
    expect(taskMap.get('pause_reminders')).toBeDefined();
    expect(taskMap.get('pause_reminders').schedule).toBe('0 * * * *');
    expect(typeof taskMap.get('pause_reminders').runner).toBe('function');
  });

  it('registers all 5 jobs when startScheduler() is called and enforces singleton initialization', async () => {
    expect(isSchedulerRunning()).toBe(false);

    const started = await startScheduler({ runInitialSweep: false });
    expect(started).toBe(true);
    expect(isSchedulerRunning()).toBe(true);

    const activeNames = getActiveJobNames();
    expect(activeNames).toEqual([
      'overdue_escalation',
      'todo_escalation',
      'blocker_dependency_alert',
      'revision_pattern_flag',
      'pause_reminders',
    ]);

    // Calling startScheduler again should return false (singleton guard)
    const secondCall = await startScheduler({ runInitialSweep: false });
    expect(secondCall).toBe(false);

    // Stop cleanly
    stopScheduler();
    expect(isSchedulerRunning()).toBe(false);
    expect(getActiveJobNames()).toHaveLength(0);
  });

  it('prevents overlapping execution of the same job', async () => {
    let slowJobResolve;
    const slowJobPromise = new Promise((resolve) => {
      slowJobResolve = resolve;
    });

    const runner = vi.fn().mockImplementation(() => slowJobPromise);

    // Start first run (will hang until slowJobResolve is called)
    const run1Promise = executeGuardedJob('test_overlap', runner);

    // Second run should be skipped because test_overlap is still running
    const run2 = await executeGuardedJob('test_overlap', runner);
    expect(run2).toEqual({ status: 'skipped', reason: 'already_running' });
    expect(runner).toHaveBeenCalledTimes(1);

    // Let the first run finish
    slowJobResolve({ done: true });
    const run1 = await run1Promise;
    expect(run1.status).toBe('completed');
    expect(run1.result).toEqual({ done: true });

    // Now a subsequent run should succeed
    const run3 = await executeGuardedJob('test_overlap', runner);
    expect(run3.status).toBe('completed');
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('catches job runner errors safely without crashing or throwing', async () => {
    const failingRunner = vi.fn().mockRejectedValue(new Error('Simulated automation failure'));

    const result = await executeGuardedJob('failing_job', failingRunner);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Simulated automation failure');
    expect(typeof result.durationMs).toBe('number');
  });
});

describe('Direct Email Processing (enqueueEmail without Redis/BullMQ)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delivers an email with rendered template directly and returns success', async () => {
    vi.spyOn(emailModule, 'deliver').mockResolvedValue({ ok: true, messageId: '<msg-123@test>' });

    const result = await enqueueEmail({
      to: 'recipient@example.com',
      template: 'notification',
      context: { name: 'Alice', title: 'Task Overdue', message: 'Your task is overdue' },
    });

    expect(result).toEqual({
      success: true,
      messageId: '<msg-123@test>',
      mode: 'direct',
    });
    expect(emailModule.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'recipient@example.com',
        template: 'notification',
      })
    );
  });

  it('handles deliver failure gracefully without throwing', async () => {
    vi.spyOn(emailModule, 'deliver').mockResolvedValue({ ok: false, error: 'SMTP connection timeout' });

    const result = await enqueueEmail({
      to: 'recipient@example.com',
      subject: 'Test Subject',
      html: '<p>Test</p>',
      text: 'Test',
    });

    expect(result).toEqual({
      success: false,
      error: 'SMTP connection timeout',
      mode: 'direct',
    });
  });

  it('validates pause_reminders as a valid enum in AutomationRule schema', () => {
    expect(AUTOMATION_RULE_KEYS).toContain('pause_reminders');
  });

  it('returns failure when template name is invalid without throwing', async () => {
    const result = await enqueueEmail({
      to: 'recipient@example.com',
      template: 'non_existent_template_xyz',
      context: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown email template/);
    expect(result.mode).toBe('direct');
  });
});
