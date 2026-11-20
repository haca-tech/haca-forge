import { normalizeRole, APPROVER_ROLES, READ_ONLY_VIEWER_ROLES } from '@mmp/shared';
import { LIVE_REPORTS, parseReportFilters, projectKpiReport } from './live.service.js';
import { seesAll } from '../../lib/roleAccess.js';

/** Roles that may open a Project KPI page. Everyone else gets the same 404 as a missing project. */

const notFound = (res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });

export function liveReportHandler(name) {
  const build = LIVE_REPORTS[name];
  return async (req, res, next) => {
    try {
      const data = await build(parseReportFilters(req.query));
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  };
}

export async function projectKpiHandler(req, res, next) {
  try {
    if (!seesAll(req.user)) return notFound(res);
    const data = await projectKpiReport(req.params.id);
    if (!data) return notFound(res);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}
