interface ArkovaLogoProps {
  size?: number;
  className?: string;
}

export function ArkovaLogo({ size = 36, className }: Readonly<ArkovaLogoProps>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="none"
      width={size}
      height={size}
      className={className}
    >
      <rect width="32" height="32" rx="8" fill="currentColor" className="text-primary" />
      <path
        d="M16 6L7 11v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12v-6L16 6z"
        fill="#ffffff"
        fillOpacity="0.25"
      />
      <path
        d="M16 8L9 12.2v5.3c0 4.63 3.2 8.95 7 10 3.8-1.05 7-5.37 7-10v-5.3L16 8z"
        fill="#ffffff"
        fillOpacity="0.15"
      />
      <path
        d="M16 10l-5 3v4c0 3.7 2.56 7.16 5 8 2.44-.84 5-4.3 5-8v-4l-5-3z"
        stroke="#ffffff"
        strokeWidth="1.5"
        fill="none"
      />
      <path
        d="M13.5 16.5l2 2 3.5-4"
        stroke="#ffffff"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
