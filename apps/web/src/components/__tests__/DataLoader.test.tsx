// The one data-loading state: the dot-matrix loader with a label, announced as a status.
import '@testing-library/jest-dom';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import { DataLoader } from '../DataLoader';

describe('DataLoader', () => {
  it('shows the label, is a busy status, and draws the loader at its compact size', () => {
    const { container } = render(<DataLoader label="Loading the tracker…" />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading the tracker…');
    const box = container.querySelector('span[aria-hidden="true"]') as HTMLElement;
    expect(box.style.width).toBe('44px');
    expect(container.querySelector('canvas')).toBeInTheDocument();
  });

  it('page and inline sizes', () => {
    const { container, rerender } = render(<DataLoader variant="page" label="Loading" />);
    expect((container.querySelector('span[aria-hidden="true"]') as HTMLElement).style.width).toBe('56px');
    rerender(<DataLoader variant="inline" label="Loading" />);
    expect((container.querySelector('span[aria-hidden="true"]') as HTMLElement).style.width).toBe('18px');
  });

  it('the old loading animations are gone: no skeletons and no ring spinners for data loading', () => {
    const src = path.resolve(__dirname, '../..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) files.push(full);
      }
    };
    walk(src);
    expect(fs.existsSync(path.join(src, 'components/Skeleton.tsx'))).toBe(false);
    const offenders = files.filter((f) => {
      const s = fs.readFileSync(f, 'utf8');
      // A large ring spinner (w-8 / w-10) was a page or panel load; small button spinners stay.
      return /PageSkeleton|w-(8|10) h-(8|10) border-\d[^"]*animate-spin/.test(s);
    });
    expect(offenders.map((f) => path.relative(src, f))).toEqual([]);
  });
});
