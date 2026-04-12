/**
 * Citation Card (NCE-11)
 *
 * Displays a citation source from Nessie's response with
 * document title, source, and anchor status.
 */

import { ExternalLink, Shield, ShieldCheck } from 'lucide-react';

interface Citation {
  record_id: string;
  title: string;
  source: string;
  source_url: string | null;
  anchor_status: string | null;
}

interface CitationCardProps {
  index: number;
  citation: Citation;
}

export function CitationCard({ index, citation }: CitationCardProps) {
  return (
    <div className="flex items-start gap-2 text-xs p-2 rounded bg-background/50 border border-border/50">
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#00d4ff]/10 text-[#00d4ff] text-[10px] flex items-center justify-center font-medium">
        {index}
      </span>
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{citation.title}</p>
        <p className="text-muted-foreground">{citation.source}</p>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {citation.anchor_status === 'SECURED' ? (
          <ShieldCheck className="h-3 w-3 text-emerald-500" />
        ) : (
          <Shield className="h-3 w-3 text-muted-foreground" />
        )}
        {citation.source_url && (
          <a
            href={citation.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#00d4ff] hover:text-[#00d4ff]/80"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}
