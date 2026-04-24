/**
 * Pricing Card Component
 *
 * Displays a subscription plan with features and pricing.
 * Uses approved terminology per Constitution.
 */

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface PricingPlan {
  id: string;
  name: string;
  description: string;
  price: number | null;
  priceLabel?: string;
  period: 'month' | 'year' | 'custom';
  features: string[];
  recordsIncluded: number | 'unlimited';
  recommended?: boolean;
  current?: boolean;
}

interface PricingCardProps {
  plan: PricingPlan;
  onSelect?: (planId: string) => void;
  loading?: boolean;
}

export function PricingCard({ plan, onSelect, loading }: Readonly<PricingCardProps>) {
  return (
    <Card
      className={cn(
        'relative flex flex-col',
        plan.recommended && 'border-primary shadow-lg',
        plan.current && 'border-success'
      )}
    >
      {plan.recommended && (
        <Badge className="absolute -top-3 left-1/2 -translate-x-1/2">
          Recommended
        </Badge>
      )}
      {plan.current && (
        <Badge variant="success" className="absolute -top-3 left-1/2 -translate-x-1/2">
          Current Plan
        </Badge>
      )}

      <CardHeader className="text-center pb-2">
        <CardTitle className="text-xl">{plan.name}</CardTitle>
        <CardDescription>{plan.description}</CardDescription>
      </CardHeader>

      <CardContent className="flex-1">
        {/* Price */}
        <div className="text-center mb-6">
          {plan.price === null ? (
            <div className="text-2xl font-bold">{plan.priceLabel || 'Contact us'}</div>
          ) : (
            <div className="flex items-baseline justify-center gap-1">
              <span className="text-4xl font-bold">${plan.price}</span>
              {plan.period !== 'custom' && (
                <span className="text-muted-foreground">
                  /{plan.period === 'month' ? 'mo' : 'yr'}
                </span>
              )}
            </div>
          )}
          <p className="text-sm text-muted-foreground mt-1">
            {plan.recordsIncluded === 'unlimited'
              ? 'Custom anchor volume'
              : `${plan.recordsIncluded} anchors/month`}
          </p>
        </div>

        {/* Features */}
        <ul className="space-y-3">
          {plan.features.map((feature, index) => (
            <li key={`${feature}-${index}`} className="flex items-start gap-2">
              <Check className="h-4 w-4 text-success mt-0.5 shrink-0" />
              <span className="text-sm">{feature}</span>
            </li>
          ))}
        </ul>
      </CardContent>

      <CardFooter>
        <Button
          className="w-full"
          variant={plan.current ? 'outline' : (plan.recommended ? 'default' : 'secondary')}
          onClick={() => onSelect?.(plan.id)}
          disabled={loading || plan.current || plan.price === null}
        >
          {plan.current ? 'Current Plan' : (plan.price === null ? 'Contact Sales' : 'Select Plan')}
        </Button>
      </CardFooter>
    </Card>
  );
}

// Pre-defined plans matching the onboarding and billing tiers.
export const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'free',
    name: 'Free',
    description: 'For occasional personal anchoring',
    price: 0,
    period: 'month',
    recordsIncluded: 3,
    features: [
      '3 document anchors per month',
      'Public verification links',
      'No verified checkmark',
    ],
  },
  {
    id: 'individual_verified_monthly',
    name: 'Verified Individual',
    description: 'For a trusted personal profile',
    price: 12,
    period: 'month',
    recordsIncluded: 10,
    recommended: true,
    features: [
      '10 document anchors per month',
      'Stripe Identity verification',
      'Verified checkmark next to your name',
    ],
  },
  {
    id: 'individual_verified_annual',
    name: 'Verified Individual Annual',
    description: 'Same verified tier, paid yearly',
    price: 120,
    period: 'year',
    recordsIncluded: 10,
    features: [
      '10 document anchors per month',
      '$10 per month when paid annually',
      'Verified checkmark next to your name',
    ],
  },
  {
    id: 'small_business',
    name: 'Small Business',
    description: 'For verified teams up to 25 self-serve seats',
    price: 500,
    period: 'month',
    recordsIncluded: 250,
    features: [
      '1 admin and 5 included seats',
      '250 anchors per month',
      '$100 per additional seat',
      '25 extra anchors per added seat',
      'Compliance intelligence access',
    ],
  },
  {
    id: 'medium_business',
    name: 'Medium Business',
    description: 'For 25-250 seats and multiple departments',
    price: null,
    priceLabel: 'Custom',
    period: 'custom',
    recordsIncluded: 'unlimited',
    features: [
      '25-250 seats',
      '3 included sub-organizations',
      'Sub-organization admins and allocations',
      'Compliance intelligence recommendations',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    description: 'For larger organizations and custom structures',
    price: null,
    priceLabel: 'Custom',
    period: 'custom',
    recordsIncluded: 'unlimited',
    features: [
      'Custom seat and anchor allocation',
      'Expanded sub-organization limits',
      'Compliance suite access',
      'Dedicated onboarding and support',
    ],
  },
];
