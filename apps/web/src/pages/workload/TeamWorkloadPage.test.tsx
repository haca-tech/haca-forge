import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TeamWorkloadPage } from './TeamWorkloadPage';
import * as authContext from '../../context/AuthContext';
import * as apiModule from '../../lib/api';

vi.mock('../../context/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiFetch: vi.fn() }));

const member = {
  person: { _id: 'p1', name: 'Asha Editor', email: 'asha@example.invalid', role: 'executive', jobRole: 'Video Editor', weeklyCapacityHours: 40 },
  capacity: 40,
  allocatedHours: 12,
  availableHours: 28,
  workloadPct: 30,
  capacityBand: 'Healthy',
  activeItemsCount: 3,
  activeWorkItems: [],
  // Even if an older API still sent these, the page must not show them.
  avgRevisions: 2.5,
};

describe('Team Workload page', () => {
  it('shows workload only: no revision, rating or speed figures', async () => {
    (authContext.useAuth as any).mockReturnValue({ user: { _id: 'a1', role: 'admin', name: 'Admin' }, hasPermission: () => true });
    (apiModule.apiFetch as any).mockResolvedValue({
      data: {
        summary: { totalMembers: 1, totalCapacityHours: 40, totalAllocatedHours: 12, availableCapacityHours: 28, overallAvgWorkload: 30, overloadedCount: 0, totalOpenItems: 3 },
        departments: [{ _id: 'd1', name: 'Design', code: 'design', totalMembers: 1, totalAllocatedHours: 12, totalCapacityHours: 40, avgWorkloadPct: 30, bandCounts: { healthy: 1, high: 0, overloaded: 0 }, members: [member] }],
      },
    });
    render(<MemoryRouter><TeamWorkloadPage /></MemoryRouter>);
    expect(await screen.findByText('Asha Editor')).toBeInTheDocument();
    expect(screen.getByText('Active Tasks')).toBeInTheDocument();
    expect(screen.getByText('28h')).toBeInTheDocument();
    expect(screen.queryByText(/Avg Revs/i)).not.toBeInTheDocument();
    expect(screen.queryByText('2.5')).not.toBeInTheDocument();
    expect(document.body.textContent || '').not.toMatch(/revision|rating|speed|turnaround/i);
  });
});
