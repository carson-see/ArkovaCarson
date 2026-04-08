interface ArkovaLogoProps {
  size?: number;
  className?: string;
}

export function ArkovaLogo({ size = 36, className }: Readonly<ArkovaLogoProps>) {
  return (
    <img
      src="/arkova-icon.png"
      alt="Arkova — Document Verification Platform"
      width={size}
      height={size}
      className={className}
      style={{ objectFit: 'contain' }}
    />
  );
}

/**
 * Drop-in replacement for lucide Shield/ShieldCheck/ShieldAlert icons.
 * Accepts the same className prop (parses h-X w-X for sizing).
 * Use this everywhere a shield icon was previously used.
 */
interface ArkovaIconProps {
  className?: string;
  strokeWidth?: number;
}

// Map Tailwind h-X classes to pixel sizes
const SIZE_MAP: Record<string, number> = {
  'h-3': 12, 'h-3.5': 14, 'h-4': 16, 'h-5': 20,
  'h-6': 24, 'h-7': 28, 'h-8': 32, 'h-10': 40, 'h-12': 48,
};

function parseSize(className?: string): number {
  if (!className) return 16;
  for (const [cls, px] of Object.entries(SIZE_MAP)) {
    if (className.includes(cls)) return px;
  }
  return 16;
}

export function ArkovaIcon({ className, strokeWidth: _sw }: Readonly<ArkovaIconProps>) {
  const size = parseSize(className);
  // Keep layout classes (mr-, ml-, mt-, mb-, shrink-0) but drop color/size classes
  const layoutClasses = (className ?? '')
    .split(/\s+/)
    .filter(c =>
      c.startsWith('mr-') || c.startsWith('ml-') || c.startsWith('mt-') || c.startsWith('mb-')
      || c.startsWith('mx-') || c.startsWith('my-')
      || c === 'shrink-0' || c === 'inline' || c === 'inline-block'
    )
    .join(' ');
  return (
    <img
      src="/arkova-icon.png"
      alt="Arkova"
      width={size}
      height={size}
      className={layoutClasses || undefined}
      style={{ objectFit: 'contain', display: 'inline-block', verticalAlign: 'middle' }}
    />
  );
}
