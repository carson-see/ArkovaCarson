/**
 * NetworkInfo — Network status + fee rates + average fee tracking
 *
 * Shows current network (signet vs mainnet), live fee rates from
 * mempool.space, estimated cost for next batch, and average fee history.
 */

import { useState, useEffect } from 'react';
import { Server, Zap, TrendingUp, DollarSign } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { MempoolFeeRates, TreasuryBalance } from '@/hooks/useTreasuryBalance';

interface NetworkInfoProps {
  feeRates: MempoolFeeRates | null;
  balance: TreasuryBalance | null;
  loading: boolean;
}

// Estimated vsize for a batch OP_RETURN transaction
// 1 P2WPKH input (~68 vB) + 1 OP_RETURN output (~45 vB) + 1 change output (~31 vB) + overhead (~11 vB) = ~155 vB
const ESTIMATED_TX_VSIZE = 155;
const BATCH_SIZE = 10_000;

function estimateBatchCost(feeRate: number): { sats: number; btc: string } {
  const sats = Math.ceil(ESTIMATED_TX_VSIZE * feeRate);
  return { sats, btc: (sats / 1e8).toFixed(8) };
}

/** Running average of fee rates seen over the session */
function useFeeHistory(feeRates: MempoolFeeRates | null) {
  const [history, setHistory] = useState<number[]>([]);

  useEffect(() => {
    if (feeRates) {
      setHistory((prev) => {
        const next = [...prev, feeRates.hour];
        // Keep last 60 samples (60 min at 1/min refresh)
        return next.slice(-60);
      });
    }
  }, [feeRates]);

  const avg = history.length > 0
    ? Math.round(history.reduce((a, b) => a + b, 0) / history.length * 10) / 10
    : null;
  const min = history.length > 0 ? Math.min(...history) : null;
  const max = history.length > 0 ? Math.max(...history) : null;

  return { avg, min, max, samples: history.length };
}

export function NetworkInfo({ feeRates, balance, loading }: Readonly<NetworkInfoProps>) {
  const feeHistory = useFeeHistory(feeRates);

  // Determine network from env (internal config, not user-facing copy)
  const networkEnv = import.meta.env.VITE_BITCOIN_NETWORK ?? 'mainnet';
  const isMainnet = networkEnv !== 'signet' && networkEnv !== 'testnet' && networkEnv !== 'testnet4';

  const nextBatchCost = feeRates ? estimateBatchCost(feeRates.hour) : null;
  const totalBatchesNeeded = balance && nextBatchCost
    ? Math.floor(balance.total / nextBatchCost.sats)
    : null;

  return (
    <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
      {/* Fee Rates Card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Network Fee Rates</CardTitle>
          <Zap className="h-4 w-4 text-amber-500" />
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
            </div>
          ) : feeRates ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <FeeRow label="Fastest" rate={feeRates.fastest} highlight />
                <FeeRow label="30 min" rate={feeRates.halfHour} />
                <FeeRow label="1 hour" rate={feeRates.hour} />
                <FeeRow label="Economy" rate={feeRates.economy} />
              </div>

              {/* Average fee tracking */}
              {feeHistory.avg !== null && (
                <div className="border-t pt-3 space-y-1">
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <TrendingUp className="h-3 w-3" />
                    Session Average ({feeHistory.samples} samples)
                  </p>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">Avg</span>
                      <p className="font-mono font-semibold">{feeHistory.avg} sat/vB</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Min</span>
                      <p className="font-mono">{feeHistory.min} sat/vB</p>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Max</span>
                      <p className="font-mono">{feeHistory.max} sat/vB</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Unable to fetch fee rates</p>
          )}
        </CardContent>
      </Card>

      {/* Network Status + Cost Estimates */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Network Status</CardTitle>
          <Server className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Network</span>
              <Badge
                variant="outline"
                className={isMainnet
                  ? 'bg-green-500/10 text-green-700 border-green-500/30'
                  : 'bg-amber-500/10 text-amber-700 border-amber-500/30'
                }
              >
                {isMainnet ? 'Production Network' : 'Test Environment'}
              </Badge>
            </div>

            {nextBatchCost && (
              <>
                <div className="border-t pt-3 space-y-2">
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <DollarSign className="h-3 w-3" />
                    Cost Estimates (at 1-hour fee rate)
                  </p>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Per Batch TX ({BATCH_SIZE.toLocaleString()} anchors)</span>
                    <span className="font-mono text-xs">{nextBatchCost.sats.toLocaleString()} sats</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Per Anchor</span>
                    <span className="font-mono text-xs">
                      {(nextBatchCost.sats / BATCH_SIZE).toFixed(4)} sats
                    </span>
                  </div>
                  {balance && balance.totalUsd !== null && balance.btcPrice && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Per Anchor (USD)</span>
                      <span className="font-mono text-xs">
                        ${((nextBatchCost.sats / BATCH_SIZE / 1e8) * balance.btcPrice).toFixed(6)}
                      </span>
                    </div>
                  )}
                </div>

                {totalBatchesNeeded !== null && (
                  <div className="flex items-center justify-between text-sm border-t pt-2">
                    <span className="text-muted-foreground">Remaining TX capacity</span>
                    <span className="font-mono font-semibold">
                      ~{totalBatchesNeeded.toLocaleString()} batches
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function FeeRow({ label, rate, highlight }: Readonly<{ label: string; rate: number; highlight?: boolean }>) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className={`font-mono text-xs ${highlight ? 'font-semibold text-amber-600' : ''}`}>
        {rate} sat/vB
      </span>
    </div>
  );
}
