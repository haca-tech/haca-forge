import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireAnyPermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import {
  calendarPlanCreateSchema,
  calendarPlanReviewSchema,
  isWorker,
} from '@mmp/shared';
import * as planController from './plan.controller.js';
import { normalizeRole } from '@mmp/shared';
import { can } from '@mmp/shared';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit for Excel/CSV
});

router.use(authenticate);

// Import & Template routes (mounted before :id)
router.get(
  '/template',
  requireAnyPermission('calendar.plan', 'calendar.approve', 'calendar.view'),
  planController.downloadTemplate
);

router.post(
  '/preview',
  requirePermission('calendar.plan'),
  upload.single('file'),
  planController.previewImport
);

router.post(
  '/commit',
  requirePermission('calendar.plan'),
  planController.commitImport
);

router.post(
  '/autofill',
  requirePermission('calendar.plan'),
  planController.autofillRow
);

// Excel-style grid: one grid per calendar + month (mounted before :id)
// Team members get 404 on every grid route (isolation rule: the grid does not exist for them).
router.use('/grid', (req, res, next) => {
  if (!can(req.user, 'calendar.view')) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  }
  return next();
});

router.get(
  '/grid',
  requireAnyPermission('calendar.plan', 'calendar.approve', 'calendar.view'),
  planController.getGrid
);

router.post(
  '/grid/rows',
  requirePermission('calendar.plan'),
  planController.saveGridRows
);

router.post(
  '/grid/upload',
  requirePermission('calendar.plan'),
  upload.single('file'),
  planController.uploadGridFile
);

// Step owner choices for a calendar (same people the grid offers), for the Add row / individual work form.
router.get('/owner-choices', requirePermission('calendar.plan'), planController.getOwnerChoices);

// Plans CRUD & review
router.get(
  '/',
  requireAnyPermission('calendar.plan', 'calendar.approve', 'calendar.view'),
  planController.listPlans
);

router.post(
  '/',
  requirePermission('calendar.plan'),
  validate(calendarPlanCreateSchema),
  planController.createPlan
);

router.get(
  '/:id',
  requireAnyPermission('calendar.plan', 'calendar.approve', 'calendar.view'),
  planController.getPlan
);

router.patch(
  '/:id/calendar',
  requirePermission('calendar.plan'),
  planController.moveCalendar
);

router.patch(
  '/:id',
  requirePermission('calendar.plan'),
  planController.updatePlan
);

router.delete(
  '/:id',
  requirePermission('calendar.plan'),
  planController.deletePlan
);

router.post(
  '/:id/rows',
  requirePermission('calendar.plan'),
  planController.addRows
);

router.patch(
  '/:id/rows/:rowId',
  requirePermission('calendar.plan'),
  planController.updateRow
);

router.delete(
  '/:id/rows/:rowId',
  requirePermission('calendar.plan'),
  planController.deleteRow
);

router.post(
  '/:id/rows/:rowId/submit',
  requirePermission('calendar.plan'),
  planController.submitRow
);

// Phase 13: apply the lead's suggested values to a row sent back; read a row's history.
router.post(
  '/:id/rows/:rowId/apply-suggestion',
  requirePermission('calendar.plan'),
  planController.applyRowSuggestion
);

router.get(
  '/:id/rows/:rowId/history',
  requireAnyPermission('calendar.plan', 'calendar.approve', 'calendar.view'),
  planController.getRowHistory
);

router.post(
  '/:id/rows/autofill',
  requirePermission('calendar.plan'),
  planController.autofillRow
);

router.post(
  '/:id/validate',
  requirePermission('calendar.plan'),
  planController.validatePlan
);

router.post(
  '/:id/submit',
  requirePermission('calendar.plan'),
  planController.submitPlan
);

router.post(
  '/:id/review',
  requirePermission('calendar.approve'),
  validate(calendarPlanReviewSchema),
  planController.reviewPlan
);

export default router;
