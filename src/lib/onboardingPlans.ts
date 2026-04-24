export type IndividualOnboardingPlanId = 'free' | 'verified_monthly' | 'verified_annual';

export interface IndividualOnboardingPlan {
  id: IndividualOnboardingPlanId;
  name: string;
  description: string;
  priceLabel: string;
  cadenceLabel?: string;
  features: string[];
  recommended?: boolean;
  profileTier: string;
  checkoutPlanId?: string;
  verifiedBadge: boolean;
}

export const INDIVIDUAL_ONBOARDING_PLANS: IndividualOnboardingPlan[] = [
  {
    id: 'free',
    name: 'Free',
    description: 'For occasional personal records',
    priceLabel: '$0',
    cadenceLabel: '/mo',
    profileTier: 'free',
    verifiedBadge: false,
    features: [
      '3 document anchors each month',
      'Public verification links',
      'No verified checkmark',
    ],
  },
  {
    id: 'verified_monthly',
    name: 'Verified',
    description: 'For a trusted individual profile',
    priceLabel: '$12',
    cadenceLabel: '/mo',
    profileTier: 'verified_individual',
    checkoutPlanId: 'individual_verified_monthly',
    verifiedBadge: true,
    recommended: true,
    features: [
      '10 document anchors each month',
      'Stripe Identity verification',
      'Verified checkmark next to your name',
    ],
  },
  {
    id: 'verified_annual',
    name: 'Verified Annual',
    description: 'Same trust tier, paid yearly',
    priceLabel: '$10',
    cadenceLabel: '/mo billed annually',
    profileTier: 'verified_individual',
    checkoutPlanId: 'individual_verified_annual',
    verifiedBadge: true,
    features: [
      '10 document anchors each month',
      'Save $24 per year',
      'Verified checkmark next to your name',
    ],
  },
];

export interface OrganizationTierMetadata {
  id: 'org_free' | 'small_business' | 'medium_business' | 'enterprise';
  name: string;
  priceLabel: string;
  includedAdmins: number | null;
  includedSeats: number | null;
  anchorsPerMonth: number | null;
  includedSubOrgs: number;
  additionalSeatPriceCents?: number;
  additionalSeatAnchorIncrement?: number;
  maxSelfServeSeats?: number;
  requiresQuote: boolean;
  canCreateSubOrgs: boolean;
}

export const ORGANIZATION_TIER_METADATA: OrganizationTierMetadata[] = [
  {
    id: 'org_free',
    name: 'Unverified Organization',
    priceLabel: '$0/mo',
    includedAdmins: 1,
    includedSeats: 1,
    anchorsPerMonth: 3,
    includedSubOrgs: 0,
    requiresQuote: false,
    canCreateSubOrgs: false,
  },
  {
    id: 'small_business',
    name: 'Small Business',
    priceLabel: '$500/mo',
    includedAdmins: 1,
    includedSeats: 5,
    anchorsPerMonth: 250,
    includedSubOrgs: 0,
    additionalSeatPriceCents: 10000,
    additionalSeatAnchorIncrement: 25,
    maxSelfServeSeats: 25,
    requiresQuote: false,
    canCreateSubOrgs: false,
  },
  {
    id: 'medium_business',
    name: 'Medium Business',
    priceLabel: 'Custom',
    includedAdmins: 1,
    includedSeats: null,
    anchorsPerMonth: null,
    includedSubOrgs: 3,
    requiresQuote: true,
    canCreateSubOrgs: true,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    priceLabel: 'Custom',
    includedAdmins: 1,
    includedSeats: null,
    anchorsPerMonth: null,
    includedSubOrgs: 3,
    requiresQuote: true,
    canCreateSubOrgs: true,
  },
];

export function getIndividualPlan(planId: IndividualOnboardingPlanId): IndividualOnboardingPlan {
  return INDIVIDUAL_ONBOARDING_PLANS.find((plan) => plan.id === planId)
    ?? INDIVIDUAL_ONBOARDING_PLANS[0];
}
