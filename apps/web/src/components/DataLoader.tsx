/**
 * DataLoader: the one loading state for data being fetched (pages, panels, lists).
 * The animated dot-matrix loader (MatrixLoader) with a short label, announced to screen readers.
 *
 *   <DataLoader variant="page" label="Loading the dashboard" />   whole page / route
 *   <DataLoader label="Loading messages" />                       a panel or list (default)
 *   <DataLoader variant="inline" label="Loading" />               inside a line of text
 *
 * Small spinners inside buttons (saving, sending) are actions, not data loading, and stay as they are.
 */
import React from 'react';
import { MatrixLoader } from './MatrixLoader';

export interface DataLoaderProps {
  label?: string;
  variant?: 'page' | 'block' | 'inline';
  className?: string;
}

const SIZES = { page: 56, block: 44, inline: 18 } as const;

export const DataLoader: React.FC<DataLoaderProps> = ({ label = 'Loading…', variant = 'block', className = '' }) => {
  if (variant === 'inline') {
    return (
      <span role="status" aria-live="polite" aria-busy="true" className={`inline-flex items-center gap-2 text-xs text-ui-muted ${className}`}>
        <MatrixLoader size={SIZES.inline} dots={9} />
        <span>{label}</span>
      </span>
    );
  }
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={`flex flex-col items-center justify-center gap-4 text-center ${variant === 'page' ? 'min-h-[50vh] py-16' : 'py-12'} ${className}`}
    >
      <MatrixLoader size={SIZES[variant]} />
      <span className="text-xs font-medium text-ui-muted">{label}</span>
    </div>
  );
};

export default DataLoader;
