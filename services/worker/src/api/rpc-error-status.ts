export function mapRpcErrorToStatus(message: string): number {
  const lowered = message.toLowerCase();
  // Auth-adjacent phrases checked FIRST — several of them contain the
  // substring "not found" (e.g. "Profile not found" = forbidden, not 404).
  // Matching on 'not found' first misclassified those as 404 + surfaced
  // raw DB messages to unauthenticated clients.
  if (
    lowered.includes('insufficient_privilege') ||
    lowered.includes('different organization') ||
    lowered.includes('only organization administrators') ||
    lowered.includes('profile not found')
  ) {
    return 403;
  }
  if (
    lowered.includes('not awaiting resolution') ||
    lowered.includes('check_violation') ||
    lowered.includes('already been superseded') ||
    lowered.includes('is already') ||
    lowered.includes('legal hold') ||
    lowered.includes('external_file_id')
  ) {
    return 409;
  }
  if (lowered.includes('not found')) return 404;
  return 500;
}
