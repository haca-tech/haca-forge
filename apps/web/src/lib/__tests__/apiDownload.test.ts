import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiDownload, ApiError } from '../api';

// The template download used a plain link: an expired login or a stopped API made the browser save
// the error text as the .xlsx, which Excel then refused to open.
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const res = (status: number, body: BodyInit, type: string) => new Response(body, { status, headers: { 'Content-Type': type } });

describe('apiDownload', () => {
  let clicked: string[];
  beforeEach(() => {
    clicked = [];
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('saves a real file under the given name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, new Uint8Array([0x50, 0x4b, 3, 4]), XLSX)));
    await apiDownload('/api/calendar-plans/template', 'template.xlsx');
    expect(clicked).toEqual(['template.xlsx']);
  });

  it('renews an expired login once, then saves the file', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(401, JSON.stringify({ error: { message: 'expired' } }), 'application/json'))
      .mockResolvedValueOnce(res(200, JSON.stringify({ success: true }), 'application/json')) // /auth/refresh
      .mockResolvedValueOnce(res(200, new Uint8Array([0x50, 0x4b]), XLSX));
    vi.stubGlobal('fetch', fetchMock);
    await apiDownload('/api/calendar-plans/template', 'template.xlsx');
    expect(clicked).toEqual(['template.xlsx']);
  });

  it('never saves an error as the file: it throws the server message instead', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(503, JSON.stringify({ error: { code: 'SERVER_RESTARTING', message: 'API server is momentarily restarting.' } }), 'application/json')));
    await expect(apiDownload('/api/calendar-plans/template', 'template.xlsx')).rejects.toMatchObject({ message: 'API server is momentarily restarting.' });
    expect(clicked).toEqual([]);
  });

  it('reports an unreachable server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    await expect(apiDownload('/x', 'f.xlsx')).rejects.toBeInstanceOf(ApiError);
    expect(clicked).toEqual([]);
  });
});
