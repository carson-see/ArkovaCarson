/**
 * Employment Verification Form (ATT-01)
 *
 * Template-driven attestation form for employment verification.
 * Pre-populates claims from structured employment fields.
 * Tracks employee consent scope.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Loader2, Briefcase } from 'lucide-react';

export interface EmploymentVerificationData {
  employeeName: string;
  title: string;
  department: string;
  startDate: string;
  endDate: string;
  currentlyEmployed: boolean;
  employmentStatus: 'current' | 'former' | 'contract' | 'intern';
  includeSalary: boolean;
  salaryBand: string;
  consentScope: 'dates_only' | 'dates_and_title' | 'full';
  consentGiven: boolean;
}

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

export function EmploymentVerificationForm({ orgName, onSubmit, onCancel, submitting }: Props) {
  const [data, setData] = useState<EmploymentVerificationData>({
    employeeName: '',
    title: '',
    department: '',
    startDate: '',
    endDate: '',
    currentlyEmployed: true,
    employmentStatus: 'current',
    includeSalary: false,
    salaryBand: '',
    consentScope: 'dates_and_title',
    consentGiven: false,
  });
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof EmploymentVerificationData>(
    key: K,
    value: EmploymentVerificationData[K],
  ) => {
    setData((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async () => {
    setError(null);

    if (!data.employeeName.trim()) { setError('Employee name is required'); return; }
    if (!data.title.trim()) { setError('Job title is required'); return; }
    if (!data.startDate) { setError('Start date is required'); return; }
    if (!data.currentlyEmployed && !data.endDate) { setError('End date is required for former employees'); return; }
    if (!data.consentGiven) { setError('Employee consent is required'); return; }

    const claims: Array<{ claim: string; evidence?: string }> = [
      { claim: 'Employment dates', evidence: data.currentlyEmployed ? `${data.startDate} to present` : `${data.startDate} to ${data.endDate}` },
      { claim: 'Employment status', evidence: data.currentlyEmployed ? 'Currently employed' : 'Former employee' },
    ];

    if (data.consentScope !== 'dates_only') {
      claims.push({ claim: 'Job title', evidence: data.title });
      if (data.department.trim()) {
        claims.push({ claim: 'Department', evidence: data.department });
      }
    }

    if (data.consentScope === 'full' && data.includeSalary && data.salaryBand.trim()) {
      claims.push({ claim: 'Salary band', evidence: data.salaryBand });
    }

    const dateRange = data.currentlyEmployed
      ? `${data.startDate} to present`
      : `${data.startDate} to ${data.endDate}`;

    await onSubmit({
      attestation_type: 'VERIFICATION',
      attester_name: orgName,
      attester_type: 'CORPORATION',
      subject_type: 'entity',
      subject_identifier: `Employment: ${data.employeeName} at ${orgName}`,
      claims,
      summary: `Employment verification for ${data.employeeName}, ${data.title} (${dateRange})`,
      metadata: {
        template: 'employment_verification',
        consent: {
          scope: data.consentScope,
          given_at: new Date().toISOString(),
        },
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-[#00d4ff]">
        <Briefcase className="h-5 w-5" />
        <span className="font-semibold">Employment Verification</span>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Employee Info */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Employee Name *</Label>
          <Input
            placeholder="Full legal name"
            value={data.employeeName}
            onChange={(e) => update('employeeName', e.target.value)}
            className="bg-transparent border-[#00d4ff]/20"
          />
        </div>
        <div className="space-y-2">
          <Label>Job Title *</Label>
          <Input
            placeholder="e.g., Senior Software Engineer"
            value={data.title}
            onChange={(e) => update('title', e.target.value)}
            className="bg-transparent border-[#00d4ff]/20"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Department</Label>
          <Input
            placeholder="e.g., Engineering, Finance"
            value={data.department}
            onChange={(e) => update('department', e.target.value)}
            className="bg-transparent border-[#00d4ff]/20"
          />
        </div>
        <div className="space-y-2">
          <Label>Employment Status</Label>
          <Select
            value={data.employmentStatus}
            onValueChange={(v) => {
              update('employmentStatus', v as EmploymentVerificationData['employmentStatus']);
              update('currentlyEmployed', v === 'current');
            }}
          >
            <SelectTrigger className="bg-transparent border-[#00d4ff]/20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="current">Currently Employed</SelectItem>
              <SelectItem value="former">Former Employee</SelectItem>
              <SelectItem value="contract">Contractor</SelectItem>
              <SelectItem value="intern">Intern</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Dates */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Start Date *</Label>
          <Input
            type="date"
            value={data.startDate}
            onChange={(e) => update('startDate', e.target.value)}
            className="bg-transparent border-[#00d4ff]/20"
          />
        </div>
        {!data.currentlyEmployed && (
          <div className="space-y-2">
            <Label>End Date *</Label>
            <Input
              type="date"
              value={data.endDate}
              onChange={(e) => update('endDate', e.target.value)}
              className="bg-transparent border-[#00d4ff]/20"
            />
          </div>
        )}
      </div>

      {/* Compensation */}
      <div className="space-y-3 rounded-lg border border-border/50 p-4">
        <div className="flex items-center gap-2">
          <Checkbox
            id="include-salary"
            checked={data.includeSalary}
            onCheckedChange={(checked) => update('includeSalary', checked === true)}
          />
          <Label htmlFor="include-salary" className="text-sm font-normal cursor-pointer">
            Include salary band (requires employee consent for full scope)
          </Label>
        </div>
        {data.includeSalary && (
          <Input
            placeholder="e.g., $120,000 - $150,000"
            value={data.salaryBand}
            onChange={(e) => update('salaryBand', e.target.value)}
            className="bg-transparent border-[#00d4ff]/20"
          />
        )}
      </div>

      {/* Consent */}
      <div className="space-y-3 rounded-lg border border-[#00d4ff]/15 bg-[#00d4ff]/5 p-4">
        <Label className="text-sm font-semibold">Employee Consent</Label>
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Disclosure Scope</Label>
          <Select value={data.consentScope} onValueChange={(v) => update('consentScope', v as EmploymentVerificationData['consentScope'])}>
            <SelectTrigger className="bg-transparent border-[#00d4ff]/20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dates_only">Dates only</SelectItem>
              <SelectItem value="dates_and_title">Dates and title</SelectItem>
              <SelectItem value="full">Full (dates, title, department, salary)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="consent-given"
            checked={data.consentGiven}
            onCheckedChange={(checked) => update('consentGiven', checked === true)}
          />
          <Label htmlFor="consent-given" className="text-sm font-normal cursor-pointer">
            Employee has provided written consent for this verification *
          </Label>
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
            <><Briefcase className="mr-2 h-4 w-4" /> Create Employment Verification</>
          )}
        </Button>
      </div>
    </div>
  );
}
