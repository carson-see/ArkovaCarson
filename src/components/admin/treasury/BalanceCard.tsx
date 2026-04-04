/**
 * BalanceCard — Live BTC balance display
 *
 * Shows confirmed + unconfirmed balance in BTC and USD.
 * Links to mempool.space for the full address view.
 */

import { ExternalLink, Wallet } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TREASURY_ADDRESS, mempoolAddressUrl } from '@/lib/platform';
import type { TreasuryBalance } from '@/hooks/useTreasuryBalance';

interface BalanceCardProps {
  balance: TreasuryBalance | null;
  loading: boolean;
}

function formatBtc(sats: number): string {
  return (sats / 1e8).toFixed(8);
}

function formatUsd(usd: number): string {
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

export function BalanceCard({ balance, loading }: Readonly<BalanceCardProps>) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">Fee Account Balance</CardTitle>
        <Wallet className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-40" />
          </div>
        ) : balance ? (
          <div className="space-y-3">
            <div>
              <p className="text-2xl font-semibold font-mono">
                {formatBtc(balance.total)}
              </p>
              {balance.totalUsd !== null && (
                <p className="text-sm text-muted-foreground">
                  {formatUsd(balance.totalUsd)}
                  {balance.btcPrice && (
                    <span className="ml-1 text-xs">
                      @ {formatUsd(balance.btcPrice)}/unit
                    </span>
                  )}
                </p>
              )}
            </div>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Confirmed</span>
                <span className="font-mono">{formatBtc(balance.confirmed)}</span>
              </div>
              {balance.unconfirmed !== 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Unconfirmed</span>
                  <span className="font-mono text-amber-600">
                    {balance.unconfirmed > 0 ? '+' : ''}{formatBtc(balance.unconfirmed)}
                  </span>
                </div>
              )}
            </div>
            <div className="border-t pt-3">
              <a
                href={mempoolAddressUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline font-mono"
              >
                {TREASURY_ADDRESS.slice(0, 12)}...{TREASURY_ADDRESS.slice(-6)}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Unable to fetch balance</p>
        )}
      </CardContent>
    </Card>
  );
}
