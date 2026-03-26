/**
 * ReceiptTable — Recent Bitcoin receipts from treasury
 *
 * Lists last 20 receipts with tx_id linked to mempool.space,
 * fee paid, confirmation status, and timestamps.
 */

import { ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { mempoolTxUrl } from '@/lib/platform';
import type { MempoolReceipt } from '@/hooks/useTreasuryBalance';

interface ReceiptTableProps {
  receipts: MempoolReceipt[];
  loading: boolean;
}

function truncateTxId(txid: string): string {
  if (txid.length <= 16) return txid;
  return `${txid.slice(0, 8)}...${txid.slice(-8)}`;
}

function formatTimestamp(unixTime: number | null): string {
  if (!unixTime) return '—';
  return new Date(unixTime * 1000).toLocaleString();
}

function isArkova(opReturn: string | null): boolean {
  if (!opReturn) return false;
  return opReturn.includes('41524b56'); // 'ARKV' hex
}

export function ReceiptTable({ receipts, loading }: Readonly<ReceiptTableProps>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Recent Network Receipts</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={`tx-skel-${i}`} className="h-10 w-full" />
            ))}
          </div>
        ) : receipts.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No receipts found for this address.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left py-2 pr-4 font-medium">Receipt ID</th>
                  <th className="text-right py-2 pr-4 font-medium hidden sm:table-cell">Fee (sats)</th>
                  <th className="text-center py-2 pr-4 font-medium">Status</th>
                  <th className="text-center py-2 pr-4 font-medium hidden md:table-cell">Type</th>
                  <th className="text-right py-2 font-medium hidden lg:table-cell">Time</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((tx) => (
                  <tr key={tx.txid} className="border-b last:border-0 hover:bg-muted/50">
                    <td className="py-2 pr-4">
                      <a
                        href={mempoolTxUrl(tx.txid)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline font-mono text-xs"
                      >
                        {truncateTxId(tx.txid)}
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    </td>
                    <td className="py-2 pr-4 text-right font-mono text-xs hidden sm:table-cell">
                      {tx.fee.toLocaleString()}
                    </td>
                    <td className="py-2 pr-4 text-center">
                      {tx.confirmed ? (
                        <Badge className="bg-green-500/10 text-green-700 border-green-500/30 text-[10px]">
                          Confirmed
                        </Badge>
                      ) : (
                        <Badge className="bg-amber-500/10 text-amber-700 border-amber-500/30 text-[10px]">
                          Unconfirmed
                        </Badge>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-center hidden md:table-cell">
                      {isArkova(tx.opReturn) ? (
                        <Badge variant="secondary" className="text-[10px]">ARKV</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right font-mono text-xs text-muted-foreground hidden lg:table-cell">
                      {formatTimestamp(tx.blockTime)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
