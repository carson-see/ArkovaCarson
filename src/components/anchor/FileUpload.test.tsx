import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileUpload } from './FileUpload';

describe('FileUpload', () => {
  it('allows picker multi-select and routes multiple files to bulk mode', () => {
    const onFileSelect = vi.fn();
    const onBulkDetected = vi.fn();

    const { container } = render(
      <FileUpload onFileSelect={onFileSelect} onBulkDetected={onBulkDetected} />
    );

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.multiple).toBe(true);

    const files = [
      new File(['one'], 'bulk-route-one.pdf', { type: 'application/pdf' }),
      new File(['two'], 'bulk-route-two.pdf', { type: 'application/pdf' }),
    ];

    fireEvent.change(input, { target: { files } });

    expect(onBulkDetected).toHaveBeenCalledWith(files);
    expect(onFileSelect).not.toHaveBeenCalled();
  });
});
