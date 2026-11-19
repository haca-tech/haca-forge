import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireAnyPermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import {
  workItemCreateSchema,
  workItemUpdateSchema,
  workItemTransitionSchema,
} from '@mmp/shared';
import * as workItemController from './controller.js';
import { workItemParam } from './access.js';

const router = Router();

router.use(authenticate);

// Every :id route on this router, including those added by submissions and media.
router.param('id', workItemParam);
router.param('stageItemId', workItemParam);

// Special Aggregated Endpoints (mounted before /:id)
router.get('/my-work', requirePermission('work.update.own'), workItemController.getMyWork);
router.get('/calendar', requireAnyPermission('work.request', 'work.update.own', 'portal.view'), workItemController.getCalendarWorkItems);
router.get('/todo', requireAnyPermission('work.request', 'work.update.own', 'portal.view'), workItemController.getTodoItems);
// Pause requests waiting for a decision (leads: their calendars; admin and read-only heads: all; others: their own).
router.get('/pause-requests', workItemController.listPauseRequests);

// Work Items CRUD & Queries
router.get('/', requireAnyPermission('work.request', 'work.update.own', 'portal.view'), workItemController.listWorkItems);
router.get('/:id/activity', requireAnyPermission('work.request', 'work.update.own', 'portal.view'), workItemController.getWorkItemActivities);
router.get('/:id', requireAnyPermission('work.request', 'work.update.own', 'portal.view'), workItemController.getWorkItem);

router.post(
  '/',
  requirePermission('work.create'),
  validate(workItemCreateSchema),
  workItemController.createWorkItem
);

router.patch(
  '/:id',
  requirePermission('work.update.own'),
  workItemController.guardWorkItemPatch,
  validate(workItemUpdateSchema),
  workItemController.updateWorkItem
);

// Central State Machine Transition
router.post(
  '/:id/transition',
  requirePermission('work.update.own'),
  validate(workItemTransitionSchema),
  workItemController.transitionWorkItem
);

router.delete('/:id', requirePermission('work.create'), workItemController.deleteWorkItem);

// Pause with lead approval (rules in pause.service.js: owner requests and cancels; the step's lead decides;
// the owner, the lead or admin resumes).
router.post('/:id/pause-request', workItemController.requestPause);
router.post('/:id/pause-request/cancel', workItemController.cancelPauseRequest);
router.post('/:id/pause-request/decide', workItemController.decidePauseRequest);
router.post('/:id/resume', workItemController.resumeStep);

export default router;
