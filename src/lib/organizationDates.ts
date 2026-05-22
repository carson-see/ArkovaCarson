type OrganizationFoundedInput = {
  founded_date?: string | null;
  created_at?: string | null;
} | null | undefined;

export function getOrganizationFoundedDisplay(organization: OrganizationFoundedInput): string | null {
  if (!organization?.founded_date) return null;

  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(organization.founded_date);
  const foundedDate = new Date(isDateOnly ? `${organization.founded_date}T00:00:00Z` : organization.founded_date);
  if (Number.isNaN(foundedDate.getTime())) return null;

  return foundedDate.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    ...(isDateOnly ? { timeZone: 'UTC' } : {}),
  });
}
