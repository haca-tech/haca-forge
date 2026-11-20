import React, { useEffect, useState } from 'react';
import type { SimpleWorkloadBand } from '@mmp/shared';
import { apiFetch } from './api';
import { bandClass } from './statusTone';

/**
 * Simple workload on screens: step counts only, no hours or percentages.
 * Bands: Available (2 or fewer due this week), Busy (up to the limit), Over (above it).
 */
export interface WorkloadFigures {
  inProgress: number;
  dueThisWeek: number;
  limit: number;
  band: SimpleWorkloadBand;
  nextDue: string | null;
}
export interface WorkloadRow extends WorkloadFigures {
  _id: string;
  name: string;
  role: string;
  jobRole: string;
  avatarUrl?: string | null;
}
export interface WorkloadList {
  bands: { available: number; busy: number; over: number };
  people: WorkloadRow[];
  jobRoles: string[];
  canEditLimit: boolean;
}

/** A coloured dot for a band, usable inside a native <option> (which cannot be styled). */
export const BAND_DOT: Record<SimpleWorkloadBand, string> = { Available: '🔵', Busy: '⚫', Over: '🔴' };

/** "3 in progress · 2 due this week" */
export const countsText = (w: Pick<WorkloadFigures, 'inProgress' | 'dueThisWeek'>) => `${w.inProgress} in progress · ${w.dueThisWeek} due this week`;

/** Owner option text: "Asha Writer — 🔵 1 due this week", with "over limit" when they are over. */
export function ownerOptionLabel(name: string, w?: WorkloadFigures | null): string {
  if (!w) return name;
  return `${name} — ${BAND_DOT[w.band] || ''} ${w.dueThisWeek} due this week${w.band === 'Over' ? ' · over limit' : ''}`;
}

/** The band as a chip; the name is always printed beside the colour. */
export const BandChip: React.FC<{ band?: SimpleWorkloadBand | string | null; className?: string }> = ({ band, className = '' }) =>
  band ? <span className={`band-chip ${bandClass(band)} px-2 py-0.5 text-[11px] font-semibold ${className}`}>{band}</span> : null;

/**
 * Everyone's workload, by person id, for owner pickers. Loads once; an empty map when the
 * caller may not see it (the pickers then show names only).
 */
export function useTeamWorkload(enabled = true): Map<string, WorkloadRow> {
  const [map, setMap] = useState<Map<string, WorkloadRow>>(new Map());
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    apiFetch<{ data: WorkloadList }>('/api/workload')
      .then((res) => {
        if (alive && Array.isArray(res?.data?.people)) setMap(new Map(res.data.people.map((p) => [String(p._id), p])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [enabled]);
  return map;
}
