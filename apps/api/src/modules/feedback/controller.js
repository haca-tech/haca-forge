import * as feedbackService from './service.js';
import { feedbackEntryCreateSchema, revisionClassifySchema } from '@mmp/shared';

export async function getFeedbackForWorkItem(req, res, next) {
  try {
    const { workItemId } = req.params;
    const result = await feedbackService.getFeedbackForWorkItem(workItemId, req.user);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function createFeedbackEntry(req, res, next) {
  try {
    const parsed = feedbackEntryCreateSchema.parse({
      ...req.body,
      workItemId: req.params.workItemId || req.body.workItemId,
    });
    const entry = await feedbackService.createFeedbackEntry(parsed, req.user);
    res.status(201).json({ success: true, data: entry });
  } catch (err) {
    next(err);
  }
}

export async function classifyRevisionFlag(req, res, next) {
  try {
    const { id } = req.params;
    const parsed = revisionClassifySchema.parse(req.body);
    const updatedFlag = await feedbackService.classifyRevisionFlag(id, parsed, req.user);
    res.json({ success: true, data: updatedFlag });
  } catch (err) {
    next(err);
  }
}

export async function listRevisionFlags(req, res, next) {
  try {
    const flags = await feedbackService.listRevisionFlags(req.query, req.user);
    res.json({ success: true, data: flags });
  } catch (err) {
    next(err);
  }
}

export async function listFeedbackThreads(req, res, next) {
  try {
    const threads = await feedbackService.listFeedbackThreads(req.query, req.user);
    res.json({ success: true, data: threads });
  } catch (err) {
    next(err);
  }
}

/** The old two-entry feedback writes (retired): 410 with where to go instead. Nothing is written. */
export function retiredFeedbackWrite(req, res) {
  const isResponse = req.body?.isResponse === true || req.body?.isResponse === 'true';
  return res.status(410).json({
    error: isResponse
      ? { code: 'FEEDBACK_REPLY_RETIRED', message: 'Use Resubmit: click Start rework on the step, then Resubmit link.' }
      : { code: 'FEEDBACK_REVISION_RETIRED', message: 'Use Review Studio (or Work Detail) to request changes.' },
  });
}
