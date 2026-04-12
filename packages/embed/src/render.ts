/**
 * Pure rendering functions for the embed widget. No DOM mutation here —
 * each function returns an HTMLElement subtree that the caller mounts.
 *
 * Keeping render pure makes it trivially unit-testable and lets us swap
 * containers (direct mount, iframe, shadow DOM) without rewriting the body.
 */

import type { AnchorData, EmbedMode } from './types';
import { rootCardStyle, STYLES } from './styles';

/** Format an ISO timestamp into a locale date string, gracefully degrading to the raw string. */
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

/**
 * Map credential_type codes to friendly labels.
 *
 * DUPLICATED from src/lib/copy.ts CREDENTIAL_TYPE_LABELS — the embed
 * package must stay dependency-free and cannot import from the main app.
 * Keep this list in sync with copy.ts when credential types are added.
 */
const CREDENTIAL_LABELS: Record<string, string> = {
  DEGREE: 'Degree',
  LICENSE: 'License',
  CERTIFICATE: 'Certificate',
  TRANSCRIPT: 'Transcript',
  PROFESSIONAL: 'Professional Credential',
  CLE: 'CLE Credit',
  BADGE: 'Digital Badge',
  ATTESTATION: 'Attestation',
  FINANCIAL: 'Financial Document',
  LEGAL: 'Legal Document',
  INSURANCE: 'Insurance Certificate',
  SEC_FILING: 'SEC Filing',
  PATENT: 'Patent',
  REGULATION: 'Regulation',
  PUBLICATION: 'Publication',
  CHARITY: 'Charity',
  FINANCIAL_ADVISOR: 'Financial Advisor',
  BUSINESS_ENTITY: 'Business Entity',
  RESUME: 'Resume / CV',
  MEDICAL: 'Medical Record',
  MILITARY: 'Military Record',
  IDENTITY: 'Identity Document',
  OTHER: 'Other',
};

function credentialLabel(code: string | null | undefined): string {
  if (!code) return '';
  return CREDENTIAL_LABELS[code] ?? code;
}

/** Truncate fingerprint for display: first 16 + last 8 chars. */
function truncateFingerprint(fp: string | null | undefined): string {
  if (!fp || fp.length < 25) return fp ?? '';
  return `${fp.slice(0, 16)}...${fp.slice(-8)}`;
}

/** Helper: create an element with attributes and children. */
function el(
  tag: string,
  attrs: Record<string, string> = {},
  children: Array<string | HTMLElement> = [],
): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === 'string') {
      node.appendChild(document.createTextNode(child));
    } else {
      node.appendChild(child);
    }
  }
  return node;
}

/** Render the loading state (skeleton spinner). */
export function renderLoading(mode: EmbedMode): HTMLElement {
  const wrap = el('div', { style: rootCardStyle(mode), 'data-arkova-state': 'loading' });
  const inner = el('div', { style: STYLES.loading }, ['Loading verification…']);
  wrap.appendChild(inner);
  return wrap;
}

/** Render the not-found / error state. */
export function renderError(mode: EmbedMode, message?: string): HTMLElement {
  const wrap = el('div', { style: rootCardStyle(mode), 'data-arkova-state': 'error' });
  const box = el('div', { style: STYLES.errorBox });
  box.appendChild(el('div', { style: STYLES.errorIcon, 'aria-hidden': 'true' }, ['✕']));
  box.appendChild(el('p', { style: STYLES.errorTitle }, ['Not Found']));
  box.appendChild(
    el('p', { style: STYLES.errorSub }, [message ?? 'This record could not be verified.']),
  );
  wrap.appendChild(box);
  return wrap;
}

/** Build the small "Verified by Arkova" brand mark. */
function brand(): HTMLElement {
  const wrap = el('div', { style: STYLES.brandWrap });
  wrap.appendChild(el('span', { style: STYLES.brandDot, 'aria-hidden': 'true' }));
  wrap.appendChild(el('span', { style: STYLES.brandText }, ['Arkova']));
  return wrap;
}

/** Render the compact one-line badge. */
export function renderCompact(data: AnchorData): HTMLElement {
  const isRevoked = data.status === 'REVOKED';
  const wrap = el('div', { style: rootCardStyle('compact'), 'data-arkova-state': 'ready' });
  const row = el('div', { style: STYLES.compactWrap });
  row.appendChild(
    el(
      'div',
      { style: isRevoked ? STYLES.compactIconRevoked : STYLES.compactIconOk, 'aria-hidden': 'true' },
      [isRevoked ? '⊘' : '✓'],
    ),
  );
  const textWrap = el('div', { style: STYLES.compactTextWrap });
  textWrap.appendChild(
    el('p', { style: STYLES.compactTitle }, [isRevoked ? 'Revoked' : 'Verified']),
  );
  if (data.filename) {
    textWrap.appendChild(el('p', { style: STYLES.compactSub }, [data.filename]));
  }
  row.appendChild(textWrap);
  row.appendChild(brand());
  wrap.appendChild(row);
  return wrap;
}

/** Build a single label/value detail row. */
function detailRow(label: string, value: string): HTMLElement {
  const row = el('div', { style: STYLES.detailRow });
  row.appendChild(el('span', { style: STYLES.detailLabel }, [label]));
  row.appendChild(el('span', { style: STYLES.detailValue, title: value }, [value]));
  return row;
}

/** Render the full multi-row card. */
export function renderFull(data: AnchorData, appBaseUrl: string): HTMLElement {
  const isRevoked = data.status === 'REVOKED';
  const wrap = el('div', { style: rootCardStyle('full'), 'data-arkova-state': 'ready' });

  // Status header
  const statusBox = el('div', { style: isRevoked ? STYLES.fullStatusRevoked : STYLES.fullStatusOk });
  statusBox.appendChild(
    el(
      'div',
      { style: isRevoked ? STYLES.fullStatusIconRevoked : STYLES.fullStatusIconOk, 'aria-hidden': 'true' },
      [isRevoked ? '⊘' : '✓'],
    ),
  );
  statusBox.appendChild(
    el('p', { style: STYLES.fullStatusTitle }, [isRevoked ? 'Record Revoked' : 'Verified']),
  );
  wrap.appendChild(statusBox);

  // Details
  const details = el('div', { style: STYLES.detailsWrap });
  if (data.filename) details.appendChild(detailRow('Document', data.filename));
  const credLabel = credentialLabel(data.credential_type);
  if (credLabel) details.appendChild(detailRow('Type', credLabel));
  if (data.issuer_name) details.appendChild(detailRow('Issuer', data.issuer_name));
  if (data.anchor_timestamp) {
    details.appendChild(detailRow('Secured', formatDate(data.anchor_timestamp)));
  }
  if (data.fingerprint) {
    details.appendChild(
      el('p', { style: STYLES.fingerprintRow }, [`fingerprint: ${truncateFingerprint(data.fingerprint)}`]),
    );
  }
  wrap.appendChild(details);

  // Footer
  const footer = el('div', { style: STYLES.footer });
  if (data.public_id) {
    const link = el(
      'a',
      {
        href: `${appBaseUrl}/verify/${encodeURIComponent(data.public_id)}`,
        target: '_blank',
        rel: 'noopener noreferrer',
        style: STYLES.footerLink,
      },
      ['Full verification details →'],
    );
    footer.appendChild(link);
  } else {
    footer.appendChild(el('span', { style: STYLES.footerLink }, ['']));
  }
  footer.appendChild(brand());
  wrap.appendChild(footer);

  return wrap;
}

/**
 * Top-level render dispatcher. Returns the rendered HTMLElement for the
 * given mode and data. Pure — does not mount anywhere.
 */
export function renderWidget(
  mode: EmbedMode,
  data: AnchorData,
  appBaseUrl: string,
): HTMLElement {
  if (mode === 'compact') return renderCompact(data);
  return renderFull(data, appBaseUrl);
}
