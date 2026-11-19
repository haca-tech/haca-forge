// Published page: GET /api/published (access, filters, fallback, no contact details), the
// shared toEmbed rules, the frame-src policy in every config, and the site-root posting rule.
// Disposable test DB, synthetic people and pieces.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {
  FRAME_SRC_HOSTS,
  FRAME_SRC_POLICY,
  SITE_ROOT_URL_ERROR,
  embedPreviewText,
  isLivePostUrl,
  isTrustedEmbedUrl,
  livePostUrlError,
  toEmbed,
} from '@mmp/shared';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { connectDB } from '../src/config/db.js';
import { Person } from '../src/modules/people/model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { ActivityEvent } from '../src/modules/activity/model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { Submission } from '../src/modules/submissions/model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const EMAIL = /@pub-page-test\.com$/;
const TAG = 'PUBT';
const MONTH = '2034-03';

describe('toEmbed: official public embeds only', () => {
  const ok = (url, kind, embedUrl, aspect) => {
    const e = toEmbed(url);
    expect(e.kind, url).toBe(kind);
    expect(e.embedUrl, url).toBe(embedUrl);
    if (aspect) expect(e.aspect, url).toBe(aspect);
    expect(isTrustedEmbedUrl(e.embedUrl), url).toBe(true);
  };

  it('Instagram /p/, /reel/, /reels/, /tv/ (also under a username, with a query)', () => {
    ok('https://www.instagram.com/p/C8xYz12AbCd/', 'instagram_post', 'https://www.instagram.com/p/C8xYz12AbCd/embed', '4:5');
    ok('https://instagram.com/reel/C8xYz12AbCd', 'instagram_reel', 'https://www.instagram.com/reel/C8xYz12AbCd/embed', '9:16');
    ok('https://www.instagram.com/reels/C8xYz12AbCd/?igsh=abc', 'instagram_reel', 'https://www.instagram.com/reel/C8xYz12AbCd/embed', '9:16');
    ok('https://www.instagram.com/tv/C8xYz12AbCd/', 'instagram_reel', 'https://www.instagram.com/tv/C8xYz12AbCd/embed', '9:16');
    ok('https://www.instagram.com/haca.official/p/C8xYz12AbCd/', 'instagram_post', 'https://www.instagram.com/p/C8xYz12AbCd/embed');
  });

  it('YouTube watch, shorts, embed, live and youtu.be, always on youtube-nocookie', () => {
    const E = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';
    ok('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s', 'youtube', E, '16:9');
    ok('https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', E);
    ok('https://youtube.com/shorts/dQw4w9WgXcQ?feature=share', 'youtube_short', E, '9:16');
    ok('https://youtu.be/dQw4w9WgXcQ?si=x', 'youtube', E);
    ok('https://www.youtube.com/embed/dQw4w9WgXcQ', 'youtube', E);
    ok('https://www.youtube.com/live/dQw4w9WgXcQ', 'youtube', E);
    expect(toEmbed('https://www.youtube.com/watch?v=short').kind).toBe('link');
    expect(toEmbed('https://www.youtube.com/@haca').kind).toBe('link');
  });

  it('Facebook videos, reels and posts through the official plugin URLs', () => {
    const v = (p) => `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(`https://www.facebook.com${p}`)}&show_text=false`;
    const p = (x) => `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(`https://www.facebook.com${x}`)}&show_text=false`;
    ok('https://www.facebook.com/haca/videos/1234567890/', 'facebook_video', v('/haca/videos/1234567890/'), '16:9');
    ok('https://m.facebook.com/watch?v=1234567890', 'facebook_video', v('/watch?v=1234567890'));
    ok('https://www.facebook.com/reel/1234567890', 'facebook_reel', v('/reel/1234567890'), '9:16');
    ok('https://www.facebook.com/haca/posts/pfbid02abcDEF', 'facebook_post', p('/haca/posts/pfbid02abcDEF'), '1:1');
    ok('https://www.facebook.com/permalink.php?story_fbid=123&id=456', 'facebook_post', p('/permalink.php?story_fbid=123&id=456'));
    expect(toEmbed('https://www.facebook.com/haca').kind).toBe('link');
  });

  it('LinkedIn posts with an activity, share or ugcPost id', () => {
    ok('https://www.linkedin.com/posts/haca_launch-activity-7123456789012345678-AbCd', 'linkedin', 'https://www.linkedin.com/embed/feed/update/urn:li:activity:7123456789012345678', '4:5');
    ok('https://www.linkedin.com/feed/update/urn:li:share:7123456789012345678/', 'linkedin', 'https://www.linkedin.com/embed/feed/update/urn:li:share:7123456789012345678');
    ok('https://linkedin.com/feed/update/urn%3Ali%3AugcPost%3A7123456789012345678', 'linkedin', 'https://www.linkedin.com/embed/feed/update/urn:li:ugcPost:7123456789012345678');
    expect(toEmbed('https://www.linkedin.com/company/haca').kind).toBe('link');
  });

  it('Google Drive files play through /preview; folders and other Drive pages stay links', () => {
    const E = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/preview';
    ok('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing', 'drive', E);
    ok('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp', 'drive', E);
    ok('https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp', 'drive', E);
    for (const url of [
      'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp',
      'https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOp',
      'https://drive.google.com/',
      'https://drive.google.com/open?id=short',
      'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit',
      'https://drive.google.com.evil.com/file/d/1AbCdEfGhIjKlMnOp/view',
    ]) {
      expect(toEmbed(url).kind, url).toBe('link');
    }
    expect(embedPreviewText('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view')).toBe('Google Drive file detected');
  });

  it('everything else is a link: other hosts, http, javascript:, credentials, ports and look-alikes', () => {
    for (const url of [
      'https://x.com/haca/status/1',
      'https://drive.google.com/file/d/abc/view',
      'http://www.instagram.com/reel/C8xYz12AbCd/',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'https://instagram.com.evil.com/reel/C8xYz12AbCd/',
      'https://evil.com/www.instagram.com/reel/C8xYz12AbCd/',
      'https://notinstagram.com/reel/C8xYz12AbCd/',
      'https://www.youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
      'https://user:pw@www.instagram.com/reel/C8xYz12AbCd/',
      'https://www.instagram.com:8443/reel/C8xYz12AbCd/',
      'https://www.instagram.com/',
      'https://www.instagram.com/reel/bad"code/',
      '',
      null,
      42,
    ]) {
      const e = toEmbed(url);
      expect(e.kind, String(url)).toBe('link');
      expect(e.embedUrl, String(url)).toBeUndefined();
    }
  });

  it('only embed URLs of the produced shapes are trusted for framing', () => {
    for (const url of [
      'https://www.instagram.com/reel/C8xYz12AbCd/',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://evil.com/embed/dQw4w9WgXcQ',
      'https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fevil.com%2Fx&show_text=false',
      'javascript:alert(1)',
      undefined,
    ]) {
      expect(isTrustedEmbedUrl(url), String(url)).toBe(false);
    }
  });

  it('the posting preview line', () => {
    expect(embedPreviewText('https://www.instagram.com/reel/C8xYz12AbCd/')).toBe('Instagram reel detected');
    expect(embedPreviewText('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('YouTube Short detected');
    expect(embedPreviewText('https://x.com/haca/status/1')).toBe('Will show as a link');
  });
});

describe('frame-src policy: one allowlist in every config', () => {
  it('covers the four embed hosts and the hosts the Review Studio viewer already frames', () => {
    for (const h of ['https://drive.google.com', 'https://www.instagram.com', 'https://www.youtube-nocookie.com', 'https://www.facebook.com', 'https://www.linkedin.com', 'https://www.youtube.com', 'https://www.figma.com']) {
      expect(FRAME_SRC_HOSTS).toContain(h);
    }
    expect(FRAME_SRC_POLICY.startsWith("frame-src 'self' ")).toBe(true);
  });

  it('vercel.json sends it on every route; Vite and helmet use the shared list', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const csp = vercel.headers.find((h) => h.source === '/(.*)')?.headers.find((x) => x.key === 'Content-Security-Policy');
    expect(csp?.value).toBe(FRAME_SRC_POLICY);
    const vite = fs.readFileSync(path.join(ROOT, 'apps/web/vite.config.ts'), 'utf8');
    expect(vite).toMatch(/FRAME_SRC_POLICY/);
    expect(vite).toMatch(/server:\s*\{[^}]*headers: securityHeaders/);
    const server = fs.readFileSync(path.join(ROOT, 'apps/api/src/server.js'), 'utf8');
    expect(server).toMatch(/frameSrc: \["'self'", \.\.\.FRAME_SRC_HOSTS\]/);
  });
});

describe('Published page API and the site-root rule', () => {
  const P = {};
  const tokens = {};
  const ids = {};
  const make = (u) => jwt.sign({ userId: u._id.toString(), email: u.email, role: u.role }, env.JWT_SECRET, { expiresIn: '1h' });
  const as = (who) => ({
    get: (url, q) => request(app).get(url).query(q || {}).set('Authorization', `Bearer ${tokens[who]}`),
    post: (url, body) => request(app).post(url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    patch: (url, body) => request(app).patch(url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
  });
  const dept = new mongoose.Types.ObjectId();
  const istDay = (ymd, hh = '10:00') => new Date(`${ymd}T${hh}:00+05:30`);

  async function piece(key, { topic, type = 'Reel', calendar = 'sm', publishedAt = null, liveUrl = '', flags = {}, steps = [], postStep = null, prefix = TAG }) {
    const p = await ContentPiece.create({
      planId: new mongoose.Types.ObjectId(),
      topic: `${prefix} ${topic}`,
      contentType: type,
      pipeline: type === 'Reel' ? 'reel_a' : 'design',
      postingDate: publishedAt || istDay(`${MONTH}-20`),
      status: 'In Progress',
      calendar,
      publishedAt,
      liveUrl,
      needsScript: false,
      needsShoot: false,
      needsContent: true,
      ...flags,
    });
    ids[key] = String(p._id);
    let order = 1;
    for (const [stageKey, owner, status = 'Approved', output] of steps) {
      const w = await WorkItem.create({
        title: `${TAG} ${topic} ${stageKey}`,
        workType: type,
        stageKey,
        stageOrder: order++,
        status,
        isLocked: false,
        reviewRequired: stageKey !== 'Post',
        contentPieceId: p._id,
        departmentId: dept,
        ownerId: P[owner]._id,
        deadline: istDay(`${MONTH}-25`),
        calendar,
        ...(stageKey === 'Post' && postStep ? postStep : {}),
      });
      if (output) {
        await Submission.create({ workItemId: w._id, stageKey, version: 1, kind: 'link', status: 'approved', submittedById: P[owner]._id, submittedAt: new Date(), linkUrl: output });
      }
    }
    return p;
  }

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const pieces = (await ContentPiece.find({ topic: /^PUB[TF] / }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ contentPieceId: { $in: pieces } }).select('_id').lean()).map((w) => w._id);
    await ActivityEvent.deleteMany({ entityId: { $in: [...steps, ...steps.map(String), ...pieces, ...pieces.map(String)] } });
    await Notification.deleteMany({ recipient: { $in: people } });
    await Submission.deleteMany({ workItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ _id: { $in: pieces } });
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    await connectDB();
    await cleanup();
    for (const [key, role] of [
      ['admin', 'admin'],
      ['creativeHead', 'creative_head'],
      ['productionHead', 'production_head'],
      ['creativeLead', 'creative_lead'],
      ['growthLead', 'growth_lead'],
      ['sm', 'sm_manager'],
      ['editorA', 'executive'],
      ['designerB', 'executive'],
      ['nobody', 'executive'],
    ]) {
      P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}@pub-page-test.com`, phone: '+15550004444', role, status: 'active' });
      tokens[key] = make(P[key]);
    }
    // 2034-03: a reel (A), an Ads YouTube Short (B), and a piece posted only through its Post step (A).
    await piece('reel', {
      topic: 'Campus reel',
      flags: { needsScript: true, needsShoot: true },
      publishedAt: istDay(`${MONTH}-10`),
      liveUrl: 'https://www.instagram.com/reel/C8xYz12AbCd/',
      steps: [['Script', 'editorA'], ['Shoot', 'editorA'], ['Edit', 'editorA'], ['Post', 'sm', 'Published']],
    });
    await piece('short', {
      topic: 'Offer short',
      calendar: 'ads',
      publishedAt: istDay(`${MONTH}-12`),
      liveUrl: 'https://youtube.com/shorts/dQw4w9WgXcQ',
      steps: [['Edit', 'designerB'], ['Post', 'sm', 'Published']],
    });
    await piece('stepOnly', {
      topic: 'Step only post',
      type: 'Static Post',
      steps: [['Content', 'editorA'], ['Design', 'designerB', 'In Progress'], ['Post', 'sm', 'Published']],
      postStep: { postedAt: istDay(`${MONTH}-05`), publishedUrl: 'https://example.org/haca/post-1' },
    });
    // Posted 31 March 23:30 IST = 31 March in IST (18:00 UTC), so it is March, not April.
    await piece('lateNight', {
      topic: 'Late night post',
      type: 'Static Post',
      flags: { needsContent: false },
      publishedAt: new Date('2034-03-31T18:00:00Z'),
      liveUrl: 'https://www.linkedin.com/posts/haca_launch-activity-7123456789012345678-AbCd',
      steps: [['Design', 'designerB'], ['Post', 'sm', 'Published']],
    });
    // April, and one never posted.
    await piece('april', { topic: 'April post', type: 'Static Post', publishedAt: istDay('2034-04-02'), liveUrl: 'https://x.com/haca/status/1', steps: [['Design', 'editorA']] });
    await piece('draft', { topic: 'Not posted', steps: [['Edit', 'editorA', 'In Progress']] });
  }, 60000);
  afterAll(cleanup, 60000);

  const list = async (who, q = {}) => {
    const res = await as(who).get('/api/published', { month: MONTH, ...q });
    expect(res.status, who).toBe(200);
    return res.body.data;
  };
  const titles = (data) => data.items.map((i) => i.title.replace(`${TAG} `, ''));

  it('leadership, admin and the SM Manager see every posted piece, newest first (IST month)', async () => {
    for (const who of ['admin', 'creativeHead', 'productionHead', 'creativeLead', 'growthLead', 'sm']) {
      const data = await list(who, { q: TAG });
      expect(titles(data), who).toEqual(['Late night post', 'Offer short', 'Campus reel', 'Step only post']);
      expect(data.total).toBe(4);
    }
  });

  it('a worker sees only pieces where they owned a step; a filter cannot widen it', async () => {
    expect(titles(await list('editorA', { q: TAG }))).toEqual(['Campus reel', 'Step only post']);
    expect(titles(await list('designerB', { q: TAG }))).toEqual(['Late night post', 'Offer short', 'Step only post']);
    expect((await list('nobody', { q: TAG })).total).toBe(0);
    expect((await list('editorA', { q: TAG, calendar: 'ads' })).total).toBe(0);
    expect(titles(await list('editorA', { month: '2034-04', q: TAG }))).toEqual(['April post']);
  });

  it('each item: title, type, workflow label, calendar, posted date, live link, embed and credits', async () => {
    const data = await list('admin', { q: 'Campus reel' });
    const [item] = data.items;
    expect(item).toMatchObject({
      id: ids.reel,
      type: 'Reel',
      workflow: 'full',
      workflowLabel: 'Reel · Full',
      calendar: 'sm',
      liveUrl: 'https://www.instagram.com/reel/C8xYz12AbCd/',
      embed: { kind: 'instagram_reel', embedUrl: 'https://www.instagram.com/reel/C8xYz12AbCd/embed', aspect: '9:16' },
    });
    expect(new Date(item.postedAt).toISOString()).toBe(istDay(`${MONTH}-10`).toISOString());
    expect(item.credits).toEqual([
      { step: 'Script', name: `${TAG} editorA` },
      { step: 'Shoot', name: `${TAG} editorA` },
      { step: 'Edit', name: `${TAG} editorA` },
      { step: 'Post', name: `${TAG} sm` },
    ]);
  });

  it('falls back to the Post step for the posted date and link; credits list finished steps only', async () => {
    const [item] = (await list('admin', { q: 'Step only' })).items;
    expect(new Date(item.postedAt).toISOString()).toBe(istDay(`${MONTH}-05`).toISOString());
    expect(item.liveUrl).toBe('https://example.org/haca/post-1');
    expect(item.embed).toEqual({ kind: 'link', label: 'Link' });
    expect(item.credits.map((c) => c.step)).toEqual(['Content', 'Post']);
  });

  it('no contact details anywhere in the response, for any role', async () => {
    for (const who of ['admin', 'creativeHead', 'sm', 'editorA']) {
      const text = JSON.stringify(await list(who, { q: TAG }));
      expect(text, who).not.toMatch(/@pub-page-test|5550004444|"email"|"phone"/);
    }
  });

  it('filters: calendar, type, workflow, search, month=all and paging', async () => {
    expect(titles(await list('admin', { q: TAG, calendar: 'ads' }))).toEqual(['Offer short']);
    expect(titles(await list('admin', { q: TAG, calendar: 'sm', type: 'Static Post' }))).toEqual(['Late night post', 'Step only post']);
    expect(titles(await list('admin', { q: TAG, workflow: 'design_only' }))).toEqual(['Late night post']);
    expect(titles(await list('admin', { q: `${TAG} offer` }))).toEqual(['Offer short']);
    const all = await as('admin').get('/api/published', { q: TAG });
    expect(all.body.data.total).toBe(5);
    const p1 = await list('admin', { q: TAG, limit: 3, page: 1 });
    const p2 = await list('admin', { q: TAG, limit: 3, page: 2 });
    expect(p1.pages).toBe(2);
    expect([...titles(p1), ...titles(p2)]).toEqual(['Late night post', 'Offer short', 'Campus reel', 'Step only post']);
  });

  it('malformed filters are 400; signed-out is 401', async () => {
    for (const q of [{ month: '2034-3' }, { calendar: 'tiktok' }, { workflow: 'everything' }]) {
      const res = await as('admin').get('/api/published', q);
      expect(res.status, JSON.stringify(q)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_FILTER');
    }
    expect((await request(app).get('/api/published')).status).toBe(401);
  });

  it('other routes are unchanged for a worker (plan grid still not found)', async () => {
    expect((await as('editorA').get('/api/calendar-plans/grid', { calendar: 'sm', month: MONTH })).status).toBe(404);
  });

  describe('posting a site homepage is refused (web and API share the rule)', () => {
    it('the shared rule', () => {
      for (const url of ['https://www.instagram.com', 'https://www.instagram.com/', 'https://youtube.com/?feature=x']) {
        expect(livePostUrlError(url), url).toBe(SITE_ROOT_URL_ERROR);
        expect(isLivePostUrl(url), url).toBe(false);
      }
      expect(livePostUrlError('https://www.instagram.com/reel/C8xYz12AbCd/')).toBeNull();
    });

    it('marking posted with a homepage is 400 with the message, and nothing changes', async () => {
      const p = await piece('rootTry', { topic: 'Root try', steps: [['Post', 'sm', 'In Progress']] });
      const post = await WorkItem.findOne({ contentPieceId: p._id, stageKey: 'Post' });
      await WorkItem.updateOne({ _id: post._id }, { $set: { startedAt: new Date(), rounds: [{ roundNumber: 1, startedAt: new Date(), intervals: [] }] } });
      const res = await as('sm').post(`/api/work/${post._id}/transition`, { toStatus: 'Published', publishedUrl: 'https://www.instagram.com/' });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain(SITE_ROOT_URL_ERROR);
      expect((await WorkItem.findById(post._id).lean()).status).toBe('In Progress');
      const okRes = await as('sm').post(`/api/work/${post._id}/transition`, { toStatus: 'Published', publishedUrl: 'https://www.instagram.com/reel/C8xYz12AbCd/' });
      expect(okRes.status).toBe(200);
    });

    it('a homepage saved earlier is left as it is, and lists as a link card', async () => {
      await piece('legacyRoot', { topic: 'Legacy root', publishedAt: istDay(`${MONTH}-03`), liveUrl: 'https://www.instagram.com/', steps: [['Edit', 'editorA']] });
      const [item] = (await list('admin', { q: 'Legacy root' })).items;
      expect(item.liveUrl).toBe('https://www.instagram.com/');
      expect(item.embed.kind).toBe('link');
    });
  });
  describe('Final asset fallback when the live link does not embed', () => {
    const FB = '2034-05';
    const DRIVE_VIDEO = 'https://drive.google.com/file/d/1FinalCutAbCdEfGh/view?usp=sharing';
    const DRIVE_DESIGN = 'https://drive.google.com/file/d/1FinalDesignAbCdEf/view';
    beforeAll(async () => {
      // A reel posted with a homepage: Script by designerB, Edit (final video) by editorA.
      await piece('fbReel', {
        prefix: 'PUBF', topic: 'Homepage reel', publishedAt: istDay(`${FB}-10`), liveUrl: 'https://www.instagram.com/',
        flags: { needsScript: true, needsShoot: false },
        steps: [['Script', 'designerB'], ['Edit', 'editorA', 'Approved', DRIVE_VIDEO], ['Post', 'sm', 'Published']],
      });
      // A design posted with an unknown link: the Design output is the final design.
      await piece('fbDesign', {
        prefix: 'PUBF', topic: 'Partner design', type: 'Static Post', publishedAt: istDay(`${FB}-11`), liveUrl: 'https://example.org/haca/p/1',
        steps: [['Content', 'editorA'], ['Design', 'designerB', 'Approved', DRIVE_DESIGN], ['Post', 'sm', 'Published']],
      });
      // A Drive folder as the final output: nothing to play.
      await piece('fbFolder', {
        prefix: 'PUBF', topic: 'Folder design', type: 'Static Post', publishedAt: istDay(`${FB}-12`), liveUrl: 'https://example.org/haca/p/2',
        steps: [['Design', 'designerB', 'Approved', 'https://drive.google.com/drive/folders/1FolderAbCdEfGhIj'], ['Post', 'sm', 'Published']],
      });
      // A live Drive file link embeds directly.
      await piece('fbLiveDrive', {
        prefix: 'PUBF', topic: 'Drive live reel', publishedAt: istDay(`${FB}-13`), liveUrl: 'https://drive.google.com/file/d/1LiveDriveAbCdEfG/view',
        steps: [['Edit', 'editorA', 'Approved', DRIVE_VIDEO], ['Post', 'sm', 'Published']],
      });
    }, 60000);
    const byTitle = async (who) => Object.fromEntries((await list(who, { month: FB, q: 'PUBF' })).items.map((i) => [i.title.replace('PUBF ', ''), i]));

    it('uses the approved Edit output for a reel and the Design output for a post, labelled; Open original stays the live link', async () => {
      const items = await byTitle('admin');
      expect(items['Homepage reel'].preview).toEqual({
        source: 'final', label: 'Final video',
        embed: { kind: 'drive', embedUrl: 'https://drive.google.com/file/d/1FinalCutAbCdEfGh/preview', aspect: '9:16', label: 'Google Drive file' },
      });
      expect(items['Homepage reel'].liveUrl).toBe('https://www.instagram.com/');
      expect(items['Homepage reel'].embed.kind).toBe('link');
      expect(items['Partner design'].preview).toMatchObject({ source: 'final', label: 'Final design', embed: { kind: 'drive', aspect: '4:5' } });
      expect(items['Folder design'].preview).toEqual({ source: 'live', embed: { kind: 'link', label: 'Link' } });
      expect(items['Drive live reel'].preview).toMatchObject({ source: 'live', embed: { kind: 'drive', embedUrl: 'https://drive.google.com/file/d/1LiveDriveAbCdEfG/preview', aspect: '9:16' } });
    });

    it('follows the Phase 3 output rules for workers', async () => {
      // editorA owns the Edit step: sees the final video.
      expect((await byTitle('editorA'))['Homepage reel'].preview.source).toBe('final');
      // designerB owned only Script, before Edit: the final video stays hidden.
      const b = await byTitle('designerB');
      expect(b['Homepage reel'].preview).toEqual({ source: 'live', embed: { kind: 'link', label: 'Link' } });
      // designerB owns the Design step of the post: sees the final design; editorA (Content, earlier) does not.
      expect(b['Partner design'].preview.source).toBe('final');
      expect((await byTitle('editorA'))['Partner design'].preview.source).toBe('live');
    });
  });

  describe('Edit live link', () => {
    let pieceId;
    let postId;
    const POSTED = '2034-06-10';
    beforeAll(async () => {
      const p = await piece('editMe', {
        prefix: 'PUBF', topic: 'Edit me', publishedAt: istDay(POSTED), liveUrl: 'https://www.instagram.com/',
        steps: [['Edit', 'editorA'], ['Post', 'sm', 'Published']],
        postStep: { postedAt: istDay(POSTED), publishedUrl: 'https://www.instagram.com/' },
      });
      pieceId = String(p._id);
      postId = String((await WorkItem.findOne({ contentPieceId: p._id, stageKey: 'Post' }).lean())._id);
    }, 60000);
    const put = (who, liveUrl) => request(app).put(`/api/published/${pieceId}/live-link`).set('Authorization', `Bearer ${tokens[who]}`).send({ liveUrl });

    it('the leads and workers get 403; the read-only heads get 403 READ_ONLY_ROLE; nothing changes', async () => {
      for (const who of ['creativeLead', 'growthLead', 'editorA']) {
        const r = await put(who, 'https://www.instagram.com/reel/C8xYz12AbCd/');
        expect(r.status, who).toBe(403);
        expect(r.body.error.code, who).toBe('FORBIDDEN_ROLE');
      }
      for (const who of ['creativeHead', 'productionHead']) {
        const r = await put(who, 'https://www.instagram.com/reel/C8xYz12AbCd/');
        expect(r.status, who).toBe(403);
        expect(r.body.error.code, who).toBe('READ_ONLY_ROLE');
      }
      expect((await ContentPiece.findById(pieceId).lean()).liveUrl).toBe('https://www.instagram.com/');
    });

    it('the same rule as posting: a homepage, http or junk is 400', async () => {
      for (const bad of ['https://www.instagram.com/', 'http://www.instagram.com/reel/C8xYz12AbCd/', 'javascript:alert(1)', '']) {
        const r = await put('sm', bad);
        expect(r.status, bad).toBe(400);
        expect(r.body.error.code).toBe('INVALID_LIVE_URL');
      }
      expect((await put('sm', 'https://www.instagram.com/')).body.error.message).toBe(SITE_ROOT_URL_ERROR);
    });

    it('the SM Manager updates the piece and the Post step together, keeps the posted date, and it is logged', async () => {
      const r = await put('sm', 'https://www.instagram.com/reel/C8xYz12AbCd/');
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual({ liveUrl: 'https://www.instagram.com/reel/C8xYz12AbCd/', changed: true });
      const p = await ContentPiece.findById(pieceId).lean();
      const step = await WorkItem.findById(postId).lean();
      expect(p.liveUrl).toBe('https://www.instagram.com/reel/C8xYz12AbCd/');
      expect(step.publishedUrl).toBe('https://www.instagram.com/reel/C8xYz12AbCd/');
      expect(p.publishedAt.toISOString()).toBe(istDay(POSTED).toISOString());
      expect(step.postedAt.toISOString()).toBe(istDay(POSTED).toISOString());
      expect(step.status).toBe('Published');
      const ev = await ActivityEvent.findOne({ entityId: { $in: [step._id, postId] }, action: 'live_link.changed' }).lean();
      expect(ev.metadata).toMatchObject({ from: 'https://www.instagram.com/', to: 'https://www.instagram.com/reel/C8xYz12AbCd/' });
      expect(String(ev.actorId)).toBe(String(P.sm._id));
      // The list now embeds it.
      const [item] = (await list('admin', { month: '2034-06', q: 'Edit me' })).items;
      expect(item.embed.kind).toBe('instagram_reel');
    });

    it('admin may too; the same link again changes nothing', async () => {
      const r = await put('admin', 'https://youtu.be/dQw4w9WgXcQ');
      expect(r.status).toBe(200);
      expect((await ContentPiece.findById(pieceId).lean()).liveUrl).toBe('https://youtu.be/dQw4w9WgXcQ');
      const again = await put('admin', 'https://youtu.be/dQw4w9WgXcQ');
      expect(again.body.data.changed).toBe(false);
      expect(await ActivityEvent.countDocuments({ entityId: { $in: [new mongoose.Types.ObjectId(postId), postId] }, action: 'live_link.changed' })).toBe(2);
    });

    it('the generic PATCH refuses publishedUrl ("Use Edit live link"); others keep their 403; other fields still save', async () => {
      const before = await WorkItem.findById(postId).lean();
      for (const [who, body] of [
        ['sm', { publishedUrl: 'https://www.instagram.com/reel/C9zzzzzzzzz/' }],
        ['admin', { publishedUrl: 'https://www.instagram.com/reel/C9zzzzzzzzz/' }],
        ['admin', { publishedUrl: before.publishedUrl }],
        ['admin', { publishedUrl: '' }],
        ['admin', { title: 'Renamed', publishedUrl: 'https://youtu.be/dQw4w9WgXcQ' }],
      ]) {
        const r = await as(who).patch(`/api/work/${postId}`, body);
        expect(r.status, `${who} ${JSON.stringify(body)}`).toBe(400);
        expect(r.body.error.code).toBe('USE_EDIT_LIVE_LINK');
        expect(r.body.error.message).toContain('Use Edit live link');
      }
      // Someone who cannot edit the step at all keeps the access answer (403), as before.
      expect((await as('editorA').patch(`/api/work/${postId}`, { publishedUrl: 'https://www.instagram.com/reel/C9zzzzzzzzz/' })).status).toBe(403);
      const after = await WorkItem.findById(postId).lean();
      expect(after.publishedUrl).toBe(before.publishedUrl);
      expect(after.title).toBe(before.title);
      expect((await ContentPiece.findById(pieceId).lean()).liveUrl).toBe(before.publishedUrl);
      // A PATCH without publishedUrl is unaffected.
      const ok = await as('admin').patch(`/api/work/${postId}`, { title: `${before.title} (checked)` });
      expect(ok.status).toBe(200);
      expect((await WorkItem.findById(postId).lean()).publishedUrl).toBe(before.publishedUrl);
    });

    it('a piece not posted yet is 409; an unknown piece 404', async () => {
      const p = await piece('notPosted', { prefix: 'PUBF', topic: 'Not posted yet', steps: [['Post', 'sm', 'In Progress']] });
      const r = await request(app).put(`/api/published/${p._id}/live-link`).set('Authorization', `Bearer ${tokens.sm}`).send({ liveUrl: 'https://www.instagram.com/reel/C8xYz12AbCd/' });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('NOT_POSTED');
      const missing = await request(app).put(`/api/published/${new mongoose.Types.ObjectId()}/live-link`).set('Authorization', `Bearer ${tokens.sm}`).send({ liveUrl: 'https://www.instagram.com/reel/C8xYz12AbCd/' });
      expect(missing.status).toBe(404);
    });
  });
});
