// Development-only API routes. mountDevRoutes does nothing when NODE_ENV=production, so these
// paths do not exist in production (they answer the normal 404).
//
// GET /api/dev/emails  every email template rendered with its sample data (subject, html, text),
//                      for the web preview page /dev/emails. Sample data only; no user data.

import { Router } from 'express';
import { TEMPLATES, renderEmail } from '../../lib/email/index.js';

export function emailPreviews() {
  return Object.entries(TEMPLATES).map(([name, template]) => {
    const rendered = renderEmail(name, template.sample);
    return { name, label: template.label, subject: rendered.subject, html: rendered.html, text: rendered.text };
  });
}

export function devRouter() {
  const router = Router();
  router.get('/emails', (_req, res) => {
    res.json({ data: emailPreviews() });
  });
  return router;
}

/** @returns {boolean} whether the dev routes were mounted */
export function mountDevRoutes(app, env) {
  if (env.NODE_ENV === 'production') return false;
  app.use('/api/dev', devRouter());
  return true;
}
