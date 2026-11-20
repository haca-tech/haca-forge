import '@testing-library/jest-dom';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { UiFeedbackHost, confirmDialog, promptDialog, resetUiFeedback, toast } from '../uiFeedback';

afterEach(() => act(() => resetUiFeedback()));

describe('App dialogs and toasts (instead of the browser popups)', () => {
  it('confirmDialog: Confirm resolves true, Cancel false, Esc false', async () => {
    render(<UiFeedbackHost />);
    let p = confirmDialog({ title: 'Delete "Plan A"?', message: 'This cannot be undone.', confirmLabel: 'Delete plan', danger: true });
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete "Plan A"?' });
    expect(dialog).toHaveTextContent('This cannot be undone.');
    // Focus starts on Cancel, the safe choice.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Delete plan' }));
    await expect(p).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

    p = confirmDialog({ title: 'Archive?' });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await expect(p).resolves.toBe(false);

    p = confirmDialog({ title: 'Leave?' });
    await screen.findByRole('alertdialog');
    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    await expect(p).resolves.toBe(false);
  });

  it('the danger confirm button is red; a normal one is the primary button', async () => {
    render(<UiFeedbackHost />);
    void confirmDialog({ title: 'Remove?', confirmLabel: 'Remove', danger: true });
    expect(await screen.findByRole('button', { name: 'Remove' })).toHaveClass('bg-red-600');
    act(() => resetUiFeedback());
    void confirmDialog({ title: 'Approve?', confirmLabel: 'Approve' });
    expect(await screen.findByRole('button', { name: 'Approve' })).toHaveClass('ui-btn-primary');
  });

  it('promptDialog validates, then resolves the trimmed value; Cancel gives null', async () => {
    render(<UiFeedbackHost />);
    const p = promptDialog({ title: 'Insert image', label: 'Image URL', validate: (v) => (v.startsWith('https://') ? null : 'Enter an https:// link.') });
    const input = await screen.findByLabelText('Image URL');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Image URL is required.');
    fireEvent.change(input, { target: { value: 'http://x' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('https://');
    fireEvent.change(input, { target: { value: '  https://x.test/a.png ' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await expect(p).resolves.toBe('https://x.test/a.png');

    const q = promptDialog({ title: 'Reason', label: 'Reason', required: false });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await expect(q).resolves.toBeNull();
  });

  it('an optional prompt accepts an empty answer (not the same as Cancel)', async () => {
    render(<UiFeedbackHost />);
    const p = promptDialog({ title: 'Reopen?', label: 'Reason (optional)', required: false, confirmLabel: 'Reopen step' });
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen step' }));
    await expect(p).resolves.toBe('');
  });

  it('Esc on a dialog opened over another modal closes only the top dialog', async () => {
    let outerClosed = false;
    const Outer = () => {
      React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (outerClosed = true);
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, []);
      return <div role="dialog" aria-label="Outer" />;
    };
    render(<><Outer /><UiFeedbackHost /></>);
    const p = confirmDialog({ title: 'Restore version 2?' });
    await screen.findByRole('alertdialog');
    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    await expect(p).resolves.toBe(false);
    expect(outerClosed).toBe(false);
  });

  it('toasts: errors use role alert and can be dismissed; empty error text gets a fallback', async () => {
    render(<UiFeedbackHost />);
    act(() => toast.error('Failed to save row'));
    expect(await screen.findByTestId('toast-error')).toHaveTextContent('Failed to save row');
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to save row');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByTestId('toast-error')).not.toBeInTheDocument());
    act(() => toast.error(undefined));
    expect(await screen.findByTestId('toast-error')).toHaveTextContent('Something went wrong');
    act(() => toast.success('Saved.'));
    expect(await screen.findByTestId('toast-success')).toHaveTextContent('Saved.');
  });
});
