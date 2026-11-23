import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import fs from 'fs';
import path from 'path';
import { ROLE_KEYS, ROLE_LABELS, getAvailableActions } from '@mmp/shared';
import { Layout } from '../Layout';
import { RoleBoundary } from '../RoleBoundary';
import { roleAccess } from '../../lib/access';

let mockUser: any = null;
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, logout: vi.fn() }),
}));

const apiFetch = vi.fn().mockResolvedValue({ data: [] });
vi.mock('../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const SRC = path.resolve(__dirname, '../..');

function renderLayout(role: string, at = '/dashboard') {
  mockUser = { _id: `${role}-1`, name: `A ${role}`, email: `${role}@haca.test`, role, status: 'active' };
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[at]}>
        <Layout>
          <div>Page</div>
        </Layout>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const hrefs = () => screen.queryAllByRole('link').map((a) => a.getAttribute('href'));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      out.push(...sourceFiles(p));
    } else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\.|\.spec\./.test(e.name)) out.push(p);
  }
  return out;
}

beforeEach(() => {
  cleanup();
  apiFetch.mockClear();
});

describe('Role labels', () => {
  it('show the new names; keys are unchanged', () => {
    expect(ROLE_LABELS.creative_head).toBe('Marketing Head');
    expect(ROLE_LABELS.growth_lead).toBe('Marketing Growth Manager');
    expect(ROLE_LABELS.creative_lead).toBe('Creative Manager');
    expect(ROLE_LABELS.production_head).toBe('Production Head');
    expect(ROLE_LABELS.sm_manager).toBe('SM Manager');
    expect(ROLE_LABELS.executive).toBe('Executive');
    expect(ROLE_LABELS.admin).toBe('Admin');
    expect(ROLE_LABELS.viewer).toBe('Viewer');
    expect([...ROLE_KEYS]).toEqual(['admin', 'creative_head', 'production_head', 'creative_lead', 'growth_lead', 'sm_manager', 'executive', 'viewer']);
  });

  it('no screen uses the old label text', () => {
    const OLD = /\b(Creative Head|Growth Lead|Creative Lead)s?\b/i;
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (OLD.test(line)) hits.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    const shared = fs.readFileSync(path.resolve(SRC, '../../../packages/shared/src/index.ts'), 'utf8');
    shared.split('\n').forEach((line, i) => {
      if (OLD.test(line)) hits.push(`shared/index.ts:${i + 1}: ${line.trim()}`);
    });
    expect(hits).toEqual([]);
  });

  it('no screen prints a raw role key ("creative lead"); they use ROLE_LABELS', () => {
    const RAW = /\brole\??\.replace\(|\(\{[\w?.]*\.role\}\)/;
    const hits: string[] = [];
    // Screens (.tsx); lib/statusTone.ts builds CSS class names from keys, which is fine.
    for (const file of sourceFiles(SRC).filter((f) => f.endsWith('.tsx'))) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (RAW.test(line) && !/ROLE_LABELS/.test(line)) hits.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});

describe('Viewer in the web app', () => {
  it('the menu offers the plan, work, Published and reports; no Review Hub, workload, issues, team or chat', () => {
    renderLayout('viewer');
    const links = hrefs();
    for (const ok of ['/dashboard', '/calendar', '/published', '/work', '/reports']) expect(links, ok).toContain(ok);
    for (const no of ['/feedback', '/workload', '/issues', '/team', '/chat', '/settings/access', '/admin/access-requests']) {
      expect(links, no).not.toContain(no);
    }
    expect(screen.queryByTestId('top-bar-chat-btn')).toBeNull();
    // No chat request either.
    expect(apiFetch.mock.calls.map((c) => String(c[0]))).not.toContain('/api/chat/channels');
  });

  it('a Marketing Head (read-only, with people and review text) keeps those items and chat', () => {
    renderLayout('creative_head');
    const links = hrefs();
    for (const ok of ['/feedback', '/workload', '/issues', '/team', '/chat']) expect(links, ok).toContain(ok);
  });

  it('forbidden pages show Not Found by URL; allowed pages open', () => {
    mockUser = { _id: 'v-1', name: 'V', role: 'viewer', status: 'active' };
    const page = (el: React.ReactElement) => render(<MemoryRouter>{el}</MemoryRouter>);
    for (const boundary of [
      <RoleBoundary key="w" permission="people.view"><div>Inside</div></RoleBoundary>,
      <RoleBoundary key="f" anyOf={['feedback.respond', 'feedback.view_all', 'review.read_all']}><div>Inside</div></RoleBoundary>,
      <RoleBoundary key="c" anyOf={['chat.use', 'chat.read']}><div>Inside</div></RoleBoundary>,
      <RoleBoundary key="r" permission="team.profile.view"><div>Inside</div></RoleBoundary>,
    ]) {
      page(boundary);
      expect(screen.queryByText('Inside')).toBeNull();
      expect(screen.getByText('Page Not Found')).toBeInTheDocument();
      cleanup();
    }
    page(<RoleBoundary permission="report.view"><div>Inside</div></RoleBoundary>);
    expect(screen.getByText('Inside')).toBeInTheDocument();
  });

  it('has no review text, contacts or step actions', () => {
    const access = roleAccess('viewer');
    expect([access.seesAll, access.isReadOnly, access.takesSteps]).toEqual([true, true, false]);
    for (const k of ['review.read_all', 'chat.use', 'chat.read', 'people.view', 'team.profile.view', 'review.decide', 'work.update.own']) {
      expect(access.can(k), k).toBe(false);
    }
    for (const status of ['Not Started', 'In Progress', 'Pending', 'Feedback', 'Blocked', 'Approved']) {
      const { actions } = getAvailableActions({ _id: 'v-1', role: 'viewer' }, { ownerId: 'someone', status, stageKey: 'Edit', isLocked: false });
      expect(actions, status).toEqual([]);
    }
  });
});
