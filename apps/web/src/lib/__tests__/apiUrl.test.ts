import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApiUrl } from '../api';

describe('buildApiUrl', () => {
  const originalEnv = import.meta.env.VITE_API_BASE_URL;

  afterEach(() => {
    (import.meta.env as any).VITE_API_BASE_URL = originalEnv;
  });

  describe('when VITE_API_BASE_URL is not set (default relative /api)', () => {
    beforeEach(() => {
      delete (import.meta.env as any).VITE_API_BASE_URL;
    });

    it('prepends /api to endpoints without leading slash', () => {
      expect(buildApiUrl('auth/login')).toBe('/api/auth/login');
    });

    it('prepends /api to endpoints with leading slash', () => {
      expect(buildApiUrl('/auth/login')).toBe('/api/auth/login');
      expect(buildApiUrl('/auth/refresh')).toBe('/api/auth/refresh');
    });

    it('preserves existing /api prefix without duplicating it', () => {
      expect(buildApiUrl('/api/workspaces')).toBe('/api/workspaces');
      expect(buildApiUrl('api/workspaces')).toBe('/api/workspaces');
    });

    it('returns absolute URLs untouched', () => {
      expect(buildApiUrl('https://example.com/api/test')).toBe('https://example.com/api/test');
      expect(buildApiUrl('http://localhost:3000/feed')).toBe('http://localhost:3000/feed');
    });
  });

  describe('when VITE_API_BASE_URL has trailing /api', () => {
    beforeEach(() => {
      (import.meta.env as any).VITE_API_BASE_URL = 'https://mmp-api-t3z8.onrender.com/api';
    });

    it('joins endpoints without duplicating /api', () => {
      expect(buildApiUrl('/auth/login')).toBe('https://mmp-api-t3z8.onrender.com/api/auth/login');
      expect(buildApiUrl('auth/login')).toBe('https://mmp-api-t3z8.onrender.com/api/auth/login');
    });

    it('strips redundant /api from endpoint to avoid duplicate /api/api', () => {
      expect(buildApiUrl('/api/auth/login')).toBe('https://mmp-api-t3z8.onrender.com/api/auth/login');
      expect(buildApiUrl('/api/uploads/file')).toBe('https://mmp-api-t3z8.onrender.com/api/uploads/file');
      expect(buildApiUrl('/api')).toBe('https://mmp-api-t3z8.onrender.com/api');
    });

    it('handles trailing slash on base URL cleanly', () => {
      (import.meta.env as any).VITE_API_BASE_URL = 'https://mmp-api-t3z8.onrender.com/api/';
      expect(buildApiUrl('/auth/me')).toBe('https://mmp-api-t3z8.onrender.com/api/auth/me');
      expect(buildApiUrl('/api/auth/me')).toBe('https://mmp-api-t3z8.onrender.com/api/auth/me');
    });
  });

  describe('when VITE_API_BASE_URL does not have /api suffix', () => {
    beforeEach(() => {
      (import.meta.env as any).VITE_API_BASE_URL = 'https://mmp-api-t3z8.onrender.com';
    });

    it('automatically ensures /api is included in the URL', () => {
      expect(buildApiUrl('/auth/login')).toBe('https://mmp-api-t3z8.onrender.com/api/auth/login');
      expect(buildApiUrl('auth/login')).toBe('https://mmp-api-t3z8.onrender.com/api/auth/login');
    });

    it('preserves existing /api prefix on endpoint without duplicating', () => {
      expect(buildApiUrl('/api/auth/login')).toBe('https://mmp-api-t3z8.onrender.com/api/auth/login');
      expect(buildApiUrl('/api/uploads/file')).toBe('https://mmp-api-t3z8.onrender.com/api/uploads/file');
    });
  });
});
