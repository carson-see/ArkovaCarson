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
              <span className="text-muted-foreground">
                /{({ month: 'mo', year: 'yr' } as Record<string, string>)[plan.period] ?? ''}
              </span>
            </div>
          )}
          <p className="text-sm text-muted-foreground mt-1">
            {plan.recordsIncluded === 'unlimited'
              ? 'Unlimited records'
              : `${plan.recordsIncluded} records/month`}
          </p>
        </div>

        {/* Features */}
        <ul className="space-y-3">
          {plan.features.map((feature) => (
            <li key={feature} className="flex items-start gap-2">
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
          disabled={loading || plan.current}
        >
          {plan.current ? 'Current Plan' : (plan.price === null ? 'Contact Sales' : 'Select Plan')}
        </Button>
      </CardFooter>
    </Card>
  );
}

// Pre-defined plans matching the documentation
export const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'individual',
    name: 'Individual',
    description: 'For personal document security',
    price: 10,
    period: 'month',
    recordsIncluded: 10,
    features: [
      'Secure up to 10 records per month',
      'Document verification',
      'Basic support',
      'Proof downloads',
    ],
  },
  {
    id: 'professional',
    name: 'Professional',
    description: 'For growing businesses',
    price: 100,
    period: 'month',
    recordsIncluded: 100,
    recommended: true,
    features: [
      'Secure up to 100 records per month',
      'Document verification',
      'Priority support',
      'Proof downloads',
      'Bulk CSV upload',
      'API access',
    ],
  },
  {
    id: 'organization',
    name: 'Organization',
    description: 'For enterprise teams',
    price: null,
    priceLabel: 'Custom',
    period: 'custom',
    recordsIncluded: 'unlimited',
    features: [
      'Unlimited records',
      'Document verification',
      'Dedicated support',
      'Proof downloads',
      'Bulk CSV upload',
      'API access',
      'Team management',
      'Custom integrations',
      'SLA guarantee',
    ],
  },
];
