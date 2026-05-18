export type BadgeStatus = 'verified' | 'pending' | 'revoked' | 'expired';

export function toBadgeStatus(anchorStatus: string): BadgeStatus {
  switch (anchorStatus) {
    case 'SECURED':
    case 'CONFIRMED':
      return 'verified';
    case 'REVOKED':
      return 'revoked';
    case 'EXPIRED':
    case 'SUPERSEDED':
      return 'expired';
    case 'PENDING':
    case 'SUBMITTED':
    case 'BROADCASTING':
    case 'PENDING_RESOLUTION':
    default:
      return 'pending';
  }
}

export const badgeColors: Record<BadgeStatus, { bg: string; text: string }> = {
  verified: { bg: '#16a34a', text: '#ffffff' },
  pending: { bg: '#6b7280', text: '#ffffff' },
  revoked: { bg: '#dc2626', text: '#ffffff' },
  expired: { bg: '#d97706', text: '#ffffff' },
};

const labels: Record<BadgeStatus, string> = {
  verified: 'Verified',
  pending: 'Pending',
  revoked: 'Revoked',
  expired: 'Expired',
};

export function generateBadgeSvg(status: BadgeStatus): string {
  const { bg, text } = badgeColors[status];
  const label = labels[status];
  const width = 20 + label.length * 7.5;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="24" viewBox="0 0 ${width} 24">`,
    `<rect rx="4" width="${width}" height="24" fill="${bg}"/>`,
    `<text x="${width / 2}" y="16" fill="${text}" font-family="sans-serif" font-size="12" font-weight="600" text-anchor="middle">${label}</text>`,
    `</svg>`,
  ].join('');
}
