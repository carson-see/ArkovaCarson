/**
 * Evidence Layers Section (COMP-01)
 *
 * Collapsible section showing the three independent evidence layers:
 * 1. Bitcoin existence proof
 * 2. AdES electronic signature (if present)
 * 3. RFC 3161 qualified timestamp (if present)
 *
 * Each layer clearly states what it proves and what it does NOT prove.
 */

import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Shield,
  FileSignature,
  Stamp,
  CheckCircle,
  AlertCircle,
  Info,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EVIDENCE_LAYER_LABELS } from '@/lib/copy';

interface EvidenceLayer {
  type: 'anchor' | 'signature' | 'timestamp';
  present: boolean;
  timestamp?: string;
  detail?: string;
}

interface EvidenceLayersSectionProps {
  layers: EvidenceLayer[];
  jurisdiction?: string | null;
  className?: string;
}

const LAYER_CONFIG = {
  anchor: {
    icon: Shield,
    title: EVIDENCE_LAYER_LABELS.ANCHOR_TITLE,
    proves: EVIDENCE_LAYER_LABELS.ANCHOR_PROVES,
    doesNotProve: EVIDENCE_LAYER_LABELS.ANCHOR_DOES_NOT_PROVE,
    color: 'text-cyan-400',
    bg: 'bg-cyan-400/10',
  },
  signature: {
    icon: FileSignature,
    title: EVIDENCE_LAYER_LABELS.SIGNATURE_TITLE,
    proves: EVIDENCE_LAYER_LABELS.SIGNATURE_PROVES,
    doesNotProve: EVIDENCE_LAYER_LABELS.SIGNATURE_DOES_NOT_PROVE,
    color: 'text-purple-400',
    bg: 'bg-purple-400/10',
  },
  timestamp: {
    icon: Stamp,
    title: EVIDENCE_LAYER_LABELS.TIMESTAMP_TITLE,
    proves: EVIDENCE_LAYER_LABELS.TIMESTAMP_PROVES,
    doesNotProve: EVIDENCE_LAYER_LABELS.TIMESTAMP_DOES_NOT_PROVE,
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
  },
};

export function EvidenceLayersSection({ layers, jurisdiction, className }: EvidenceLayersSectionProps) {
  const [expanded, setExpanded] = useState(false);

  const presentLayers = layers.filter(l => l.present);

  return (
    <div className={className}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between py-3 text-left hover:bg-accent/50 rounded-sm px-2 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{EVIDENCE_LAYER_LABELS.SECTION_TITLE}</span>
          <Badge variant="outline" className="text-xs">{presentLayers.length} active</Badge>
        </div>
        {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="space-y-4 mt-2 px-2">
          <p className="text-xs text-muted-foreground">{EVIDENCE_LAYER_LABELS.SECTION_DESCRIPTION}</p>

          {layers.map(layer => {
            const config = LAYER_CONFIG[layer.type];
            const Icon = config.icon;

            return (
              <div key={layer.type} className={`rounded-sm border p-4 ${layer.present ? '' : 'opacity-50'}`}>
                <div className="flex items-center gap-3 mb-2">
                  <div className={`flex h-8 w-8 items-center justify-center rounded-sm ${config.bg}`}>
                    <Icon className={`h-4 w-4 ${config.color}`} />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{config.title}</span>
                      {layer.present ? (
                        <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </div>
                    {layer.timestamp && (
                      <span className="text-xs text-muted-foreground">{new Date(layer.timestamp).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC</span>
                    )}
                  </div>
                </div>

                {layer.present && (
                  <div className="space-y-2 ml-11">
                    {layer.detail && (
                      <p className="text-xs text-foreground">{layer.detail}</p>
                    )}
                    <div className="text-xs">
                      <p className="text-emerald-400/80"><span className="font-medium">Proves:</span> {config.proves}</p>
                    </div>
                    <div className="text-xs">
                      <p className="text-amber-400/80"><span className="font-medium">Does not prove:</span> {config.doesNotProve}</p>
                    </div>
                  </div>
                )}

                {!layer.present && (
                  <p className="text-xs text-muted-foreground ml-11">Not present for this credential.</p>
                )}
              </div>
            );
          })}

          {jurisdiction && (
            <div className="text-xs text-muted-foreground border-t pt-3">
              <span className="font-medium">Legal effect: </span>
              {jurisdiction === 'EU' || jurisdiction === 'UK'
                ? EVIDENCE_LAYER_LABELS.LEGAL_EFFECT_EIDAS_ADES
                : EVIDENCE_LAYER_LABELS.LEGAL_EFFECT_ESIGN}
            </div>
          )}

          <p className="text-xs text-muted-foreground/70 border-t pt-3">{EVIDENCE_LAYER_LABELS.DISCLAIMER}</p>
        </div>
      )}
    </div>
  );
}
