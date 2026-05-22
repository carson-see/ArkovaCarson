type OrganizationFoundedInput = {
  founded_date?: string | null;
  created_at?: string | null;
} | null | undefined;

export function getOrganizationFoundedDisplay(organization: OrganizationFoundedInput): string | null {
  if (!organization?.founded_date) return null;

  const foundedDate = new Date(organization.founded_date);
  if (Number.isNaN(foundedDate.getTime())) return null;

  return foundedDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
