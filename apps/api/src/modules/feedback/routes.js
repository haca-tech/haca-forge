import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireAnyPermission } from '../../middleware/requirePermission.js';
import * as feedbackController from './controller.js';
import { requireBodyWorkItemAccess, workItemParam } from '../workItems/access.js';

export const feedbackRouter = Router();

feedbackRouter.use(authenticate);
feedbackRouter.param('workItemId', workItemParam);

// Feedback threads list
feedbackRouter.get(
  '/threads',
  requireAnyPermission('analytics.team', 'feedback.view_all'),
  feedbackController.listFeedbackThreads
);

// Feedback per work item
feedbackRouter.get(
  '/work-item/:workItemId',
  requireAnyPermission('feedback.respond', 'feedback.give', 'feedback.view_all'),
  feedbackController.getFeedbackForWorkItem
);
// Retired (Review Hub): leads send work back in Review Studio or Work Detail; owners answer by
// Start rework and Resubmit link. Both writes return 410; saved entries stay readable.
feedbackRouter.post(
  '/work-item/:workItemId',
  requireAnyPermission('feedback.give', 'feedback.respond'),
  feedbackController.retiredFeedbackWrite
);
feedbackRouter.post(
  '/',
  requireAnyPermission('feedback.give', 'feedback.respond'),
  requireBodyWorkItemAccess,
  feedbackController.retiredFeedbackWrite
);

export const revisionsRouter = Router();

revisionsRouter.use(authenticate);

// Revision Flags
revisionsRouter.get(
  '/flags',
  requireAnyPermission('analytics.team', 'feedback.view_all'),
  feedbackController.listRevisionFlags
);
revisionsRouter.post(
  '/flags/:id/classify',
  requirePermission('revision.classify'),
  feedbackController.classifyRevisionFlag
);
