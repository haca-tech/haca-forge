import express from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission, requireAnyPermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import { adminUpdatePersonBasicSchema } from '@mmp/shared';
import * as peopleController from './controller.js';

import { ratingsSummaryHandler } from '../submissions/controller.js';

const router = express.Router();

// All people routes require authentication
router.use(authenticate);

// Listing & Candidate endpoints
router.get('/', requireAnyPermission('user.manage', 'people.assign', 'people.view'), peopleController.listPeople);
router.get('/assignment-candidates', requireAnyPermission('people.assign', 'work.create', 'people.view'), peopleController.getAssignmentCandidates);
router.get('/performance/team', requireAnyPermission('analytics.team', 'people.view'), peopleController.getTeamPerformance);
router.get('/:id/performance', requireAnyPermission('people.view'), peopleController.getPersonPerformance);
router.get('/:id/ratings', ratingsSummaryHandler);
router.get('/:id/profile', peopleController.getPersonProfileHandler);
router.get('/:id/work-history', peopleController.getPersonWorkHistoryHandler);
router.get('/:id', requireAnyPermission('user.manage', 'people.assign', 'people.view'), peopleController.getPersonById);

// Admin-only creation & profile updates
router.post('/', requirePermission('user.manage'), peopleController.createPerson);
router.patch('/:id/basic-info', requirePermission('user.manage'), validate(adminUpdatePersonBasicSchema), peopleController.adminUpdateBasicInfoHandler);
router.delete('/:id/avatar', requirePermission('user.manage'), peopleController.adminRemoveAvatarHandler);

// Update: Admin (user.manage) or Marketing Head (people.assign)
router.patch('/:id', requireAnyPermission('user.manage', 'people.assign'), peopleController.updatePerson);
router.put('/:id', requireAnyPermission('user.manage', 'people.assign'), peopleController.updatePerson);

// Admin-only lifecycle controls
router.post('/:id/suspend', requirePermission('user.manage'), peopleController.suspendPerson);
router.post('/:id/reactivate', requirePermission('user.manage'), peopleController.reactivatePerson);

export default router;
