/* eslint-disable arkova/no-unscoped-service-test -- UI-only disabled-button regression; no Supabase query is exercised */
/**
 * SecureDocumentDialog UAT regressions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SecureDocumentDialog } from './SecureDocumentDialog';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock('@/hooks/useAuditorMode', () => ({
  useAuditorMode: () => ({ isAuditorMode: false }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({ profile: { org_id: 'org-1' } }),
}));

vi.mock('@/lib/switchboard', () => ({
  isAIExtractionEnabled: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/components/upload', () => ({
  BulkUploadWizard: () => <div data-testid="bulk-upload-wizard" />,
}));

vi.mock('./FileUpload', () => ({
  FileUpload: () => <div data-testid="file-upload" />,
}));

vi.mock('./TemplateSelector', () => ({
  TemplateSelector: () => <div data-testid="template-selector" />,
}));

vi.mock('./AIFieldSuggestions', () => ({
  AIFieldSuggestions: () => <div data-testid="ai-field-suggestions" />,
}));

vi.mock('./ExtractionQualityBanner', () => ({
  ExtractionQualityBanner: () => <div data-testid="extraction-quality-banner" />,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn() },
    from: vi.fn(),
  },
}));

vi.mock('@/lib/auditLog', () => ({
  logAuditEvent: vi.fn(),
}));

vi.mock('@/lib/aiExtraction', () => ({
  runExtraction: vi.fn(),
  fetchTemplateReconstruction: vi.fn(),
}));

vi.mock('@/lib/templateMapper', () => ({
  applyTemplate: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

describe('SecureDocumentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables Continue with aria-disabled until a document is selected', () => {
    render(
      <SecureDocumentDialog
        open
        onOpenChange={vi.fn()}
      />,
    );

    const continueButton = screen.getByTestId('secure-dialog-continue');
    expect(screen.getByTestId('file-upload')).toBeInTheDocument();
    expect(continueButton).toBeDisabled();
    expect(continueButton).toHaveAttribute('aria-disabled', 'true');
  });
});
