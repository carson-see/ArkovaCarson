/**
 * Compliance Score Gauge (NCE-10)
 *
 * Circular gauge displaying 0-100 compliance score with color coding.
 */

interface ComplianceScoreGaugeProps {
  score: number;
  grade: string;
  size?: 'sm' | 'md' | 'lg';
}

const GRADE_COLORS: Record<string, string> = {
  A: 'text-emerald-500',
  B: 'text-blue-500',
  C: 'text-amber-500',
  D: 'text-orange-500',
  F: 'text-red-500',
};

const STROKE_COLORS: Record<string, string> = {
  A: 'stroke-emerald-500',
  B: 'stroke-blue-500',
  C: 'stroke-amber-500',
  D: 'stroke-orange-500',
  F: 'stroke-red-500',
};

const SIZES = {
  sm: { width: 80, stroke: 6, fontSize: 'text-lg', gradeSize: 'text-xs' },
  md: { width: 120, stroke: 8, fontSize: 'text-3xl', gradeSize: 'text-sm' },
  lg: { width: 160, stroke: 10, fontSize: 'text-4xl', gradeSize: 'text-base' },
};

export function ComplianceScoreGauge({ score, grade, size = 'md' }: ComplianceScoreGaugeProps) {
  const { width, stroke, fontSize, gradeSize } = SIZES[size];
  const radius = (width - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;
  const offset = circumference - progress;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width, height: width }}>
      <svg width={width} height={width} className="-rotate-90">
        <circle
          cx={width / 2}
          cy={width / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          className="text-muted/20"
        />
        <circle
          cx={width / 2}
          cy={width / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={`transition-all duration-700 ease-out ${STROKE_COLORS[grade] ?? STROKE_COLORS.F}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`font-semibold ${fontSize} ${GRADE_COLORS[grade] ?? GRADE_COLORS.F}`}>
          {score}
        </span>
        <span className={`font-medium ${gradeSize} text-muted-foreground`}>
          Grade {grade}
        </span>
      </div>
    </div>
  );
}
