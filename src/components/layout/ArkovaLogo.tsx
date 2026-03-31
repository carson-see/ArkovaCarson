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
