import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerWebComponent } from './web-component';

// Mock fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

describe('ArkovaVerifyElement', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          verified: true,
          status: 'ACTIVE',
          issuer_name: 'Test University',
          credential_type: 'DEGREE',
          anchor_timestamp: '2026-01-01T00:00:00Z',
          public_id: 'ARK-TEST-001',
        }),
        { status: 200 },
      ),
    );
  });

  it('registers arkova-verify custom element', () => {
    registerWebComponent();
    expect(customElements.get('arkova-verify')).toBeDefined();
  });

  it('registerWebComponent is idempotent', () => {
    registerWebComponent();
    registerWebComponent();
    expect(customElements.get('arkova-verify')).toBeDefined();
  });

  it('renders error when credential attribute is missing', async () => {
    registerWebComponent();

    const el = document.createElement('arkova-verify');
    document.body.appendChild(el);

    await new Promise((r) => setTimeout(r, 50));

    const shadow = el.shadowRoot;
    expect(shadow).toBeTruthy();
    expect(shadow!.innerHTML).toContain('Missing credential');

    document.body.removeChild(el);
  });

  it('fetches and renders widget when credential is provided', async () => {
    registerWebComponent();

    const el = document.createElement('arkova-verify');
    el.setAttribute('credential', 'ARK-TEST-001');
    document.body.appendChild(el);

    await new Promise((r) => setTimeout(r, 100));

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/verify/ARK-TEST-001'),
      expect.any(Object),
    );

    const shadow = el.shadowRoot;
    expect(shadow).toBeTruthy();
    expect(shadow!.innerHTML).toContain('Verified');

    document.body.removeChild(el);
  });

  it('passes mode=compact attribute through', async () => {
    registerWebComponent();

    const el = document.createElement('arkova-verify');
    el.setAttribute('credential', 'ARK-TEST-001');
    el.setAttribute('mode', 'compact');
    document.body.appendChild(el);

    await new Promise((r) => setTimeout(r, 100));

    const shadow = el.shadowRoot;
    expect(shadow!.innerHTML).toContain('data-arkova-mode="compact"');

    document.body.removeChild(el);
  });
});
