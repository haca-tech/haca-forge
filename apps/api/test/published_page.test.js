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
    for (const h of ['https://www.instagram.com', 'https://www.youtube-nocookie.com', 'https://www.facebook.com', 'https://www.linkedin.com', 'https://www.youtube.com', 'https://www.figma.com']) {
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

  async function piece(key, { topic, type = 'Reel', calendar = 'sm', publishedAt = null, liveUrl = '', flags = {}, steps = [], postStep = null }) {
    const p = await ContentPiece.create({
      planId: new mongoose.Types.ObjectId(),
      topic: `${TAG} ${topic}`,
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
    for (const [stageKey, owner, status = 'Approved'] of steps) {
      await WorkItem.create({
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
    }
    return p;
  }

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const pieces = (await ContentPiece.find({ topic: new RegExp(`^${TAG} `) }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ contentPieceId: { $in: pieces } }).select('_id').lean()).map((w) => w._id);
    await ActivityEvent.deleteMany({ entityId: { $in: [...steps, ...steps.map(String), ...pieces, ...pieces.map(String)] } });
    await Notification.deleteMany({ recipient: { $in: people } });
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
      const edit = await as('sm').patch(`/api/work/${post._id}`, { publishedUrl: 'https://www.youtube.com/' });
      expect(edit.status).toBe(400);
      expect(edit.body.error.message).toContain(SITE_ROOT_URL_ERROR);
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
});
