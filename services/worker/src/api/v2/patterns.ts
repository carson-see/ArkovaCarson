export const ORG_PUBLIC_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{2,100}$';
export const ARKOVA_PUBLIC_ID_PATTERN = '^ARK-[A-Z0-9-]{3,60}$';
export const SHA256_HEX_PATTERN = '^[a-fA-F0-9]{64}$';

export const ORG_PUBLIC_ID_RE = new RegExp(ORG_PUBLIC_ID_PATTERN);
export const ARKOVA_PUBLIC_ID_RE = new RegExp(ARKOVA_PUBLIC_ID_PATTERN);
export const SHA256_HEX_RE = new RegExp(SHA256_HEX_PATTERN);
