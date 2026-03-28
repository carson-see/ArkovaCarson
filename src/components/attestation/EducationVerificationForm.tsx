/**
 * Education Verification Form (ATT-02)
 *
 * Template-driven attestation form for education credential verification.
 * Pre-populates claims from structured academic fields.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, GraduationCap } from 'lucide-react';

export interface EducationVerificationData {
  studentName: string;
  degreeType: string;
  fieldOfStudy: string;
  institution: string;
  graduationDate: string;
  gpa: string;
  honors: string;
}

const DEGREE_TYPES = [
  'Associate of Arts (A.A.)',
  'Associate of Science (A.S.)',
  'Bachelor of Arts (B.A.)',
  'Bachelor of Science (B.S.)',
  'Bachelor of Engineering (B.E.)',
  'Master of Arts (M.A.)',
  'Master of Science (M.S.)',
  'Master of Business Administration (M.B.A.)',
  'Doctor of Philosophy (Ph.D.)',
  'Doctor of Medicine (M.D.)',
  'Juris Doctor (J.D.)',
  'Certificate',
  'Diploma',
  'Other',
] as const;

interface Props {
  orgName: string;
  onSubmit: (data: {
    attestation_type: string;
    attester_name: string;
    attester_type: string;
    subject_type: string;
    subject_identifier: string;
    claims: Array<{ claim: string; evidence?: string }>;
    summary: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
  onCancel: () => void;
  submitting: boolean;
}

export function EducationVerificationForm({ orgName, onSubmit, onCancel, submitting }: Props) {
  const [data, setData] = useState<EducationVerificationData>({
    studentName: '',
    degreeType: 'Bachelor of Science (B.S.)',
    fieldOfStudy: '',
    institution: orgName || '',
    graduationDate: '',
    gpa: '',
    honors: '',
  });
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof EducationVerificationData>(
    key: K,
    value: EducationVerificationData[K],
  ) => {
    setData((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async () => {
    setError(null);

    if (!data.studentName.trim()) { setError('Student name is required'); return; }
    if (!data.fieldOfStudy.trim()) { setError('Field of study is required'); return; }
    if (!data.institution.trim()) { setError('Institution name is required'); return; }
    if (!data.graduationDate) { setError('Graduation date is required'); return; }

    const claims: Array<{ claim: string; evidence?: string }> = [
      { claim: 'Degree', evidence: data.degreeType },
      { claim: 'Field of study', evidence: data.fieldOfStudy },
      { claim: 'Institution', evidence: data.institution },
      { claim: 'Graduation date', evidence: data.graduationDate },
    ];

    if (data.gpa.trim()) {
      claims.push({ claim: 'GPA', evidence: data.gpa });
    }

    if (data.honors.trim()) {
      claims.push({ claim: 'Honors', evidence: data.honors });
    }

    await onSubmit({
      attestation_type: 'VERIFICATION',
      attester_name: data.institution,
      attester_type: 'INSTITUTION',
      subject_type: 'credential',
      subject_identifier: `${data.degreeType}, ${data.fieldOfStudy}`,
      claims,
      summary: `${data.degreeType} in ${data.fieldOfStudy} conferred to ${data.studentName} by ${data.institution} on ${data.graduationDate}`,
      metadata: {
        template: 'education_verification',
        student_name: data.studentName,
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-[#00d4ff]">
        <GraduationCap className="h-5 w-5" />
        <span className="font-semibold">Education Credential Verification</span>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Student + Institution */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Student Name *</Label>
          <Input
            placeholder="Full legal name"
            value={data.studentName}
            onChange={(e) => update('studentName', e.target.value)}
            className="bg-transparent border-[#00d4ff]/20"
          />
        </div>
        <div className="space-y-2">
          <Label>Institution *</Label>
          <Input
            placeholder="e.g., University of Michigan"
            value={data.institution}
            onChange={(e) => update('institution', e.target.value)}
            className="bg-transparent border-[#00d4ff]/20"
          />
        </div>
      </div>

      {/* Degree */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Degree Type *</Label>
          <Select value={data.degreeType} onValueChange={(v) => update('degreeType', v)}>
            <SelectTrigger className="bg-transparent border-[#00d4ff]/20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DEGREE_TYPES.map((d) => (
                <SelectItem key={d} value={d}>{d}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Field of Study *</Label>
          <Input
            placeholder="e.g., Computer Science"
            value={data.fieldOfStudy}
            onChange={(e) => update('fieldOfStudy', e.target.value)}
            className="bg-transparent border-[#00d4ff]/20"
          />
        </div>
      </div>

      {/* Date + GPA + Honors */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label>Graduation Date *</Label>
          <Input
            type="date"
            value={data.graduationDate}
            onChange={(e) => update('graduationDate', e.target.value)}
            className="bg-transparent border-[#00d4ff]/20"
          />
        </div>
        <div className="space-y-2">
          <Label>GPA (optional)</Label>
          <Input
            placeholder="e.g., 3.85"
            value={data.gpa}
            onChange={(e) => update('gpa', e.target.value)}
            className="bg-transparent border-[#00d4ff]/20"
          />
        </div>
        <div className="space-y-2">
          <Label>Honors (optional)</Label>
          <Input
            placeholder="e.g., Magna Cum Laude"
            value={data.honors}
            onChange={(e) => update('honors', e.target.value)}
            className="bg-transparent border-[#00d4ff]/20"
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-3 pt-2">
        <Button variant="outline" onClick={onCancel} className="border-[#00d4ff]/20">
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={submitting}>
          {submitting ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating...</>
          ) : (
            <><GraduationCap className="mr-2 h-4 w-4" /> Create Education Verification</>
          )}
        </Button>
      </div>
    </div>
  );
}
