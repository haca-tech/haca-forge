import { Router } from 'express';
import { roleGuide } from '@mmp/shared';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import * as svc from './accessAdmin.service.js';

/** Access & Approvals admin page (Phase D). Only `settings.access.manage` (the admin role). */
const router = Router();
router.use(authenticate);
router.use(requirePermission('settings.access.manage'));

const q = (v) => (typeof v === 'string' ? v : '');

router.get('/people', async (req, res) => {
  res.json({ data: await svc.listPeople({ search: q(req.query.search), role: q(req.query.role), status: q(req.query.status) }) });
});
router.post('/people/:id/preview', async (req, res) => {
  res.json({ data: await svc.previewPersonChange(req.params.id, req.body || {}, req.user) });
});
router.patch('/people/:id', async (req, res) => {
  res.json({ data: await svc.savePersonChange(req.params.id, req.body || {}, req.user) });
});

router.get('/calendars', async (_req, res) => {
  res.json({ data: await svc.getCalendars() });
});
router.post('/calendars/:calendar/preview', async (req, res) => {
  res.json({ data: await svc.previewCalendarChange(req.params.calendar, req.body?.changes || {}) });
});
router.put('/calendars/:calendar', async (req, res) => {
  res.json({ data: await svc.saveCalendarChange(req.params.calendar, req.body || {}, req.user) });
});

router.get('/history', async (req, res) => {
  res.json({ data: await svc.listHistory({ person: q(req.query.person), calendar: q(req.query.calendar), type: q(req.query.type) }) });
});
router.post('/history/:id/restore', async (req, res) => {
  res.json({ data: await svc.restoreCalendarVersion(req.params.id, { preview: Boolean(req.body?.preview), reason: req.body?.reason, version: req.body?.version }, req.user) });
});

router.get('/role-guide', (_req, res) => {
  res.json({ data: roleGuide() });
});

export default router;
