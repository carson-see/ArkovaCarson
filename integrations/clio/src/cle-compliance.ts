/**
 * CLE Compliance Tab for Clio (INT-06)
 *
 * Provides bar number lookup and CLE compliance tracking via Arkova's
 * existing CLE verification infrastructure. Allows law firms to:
 * - Look up attorney bar status by bar number + jurisdiction
 * - Check CLE hour completion against requirements
 * - View Bitcoin-anchored verification of CLE credentials
 */

import type { CleStatus } from './types';

const ARKOVA_DEFAULT_URL = 'https://arkova-worker-270018525501.us-central1.run.app';

/** CLE requirements by jurisdiction (from Arkova CLE database) */
export const CLE_REQUIREMENTS: Record<
  string,
  { hours_per_cycle: number; cycle_years: number; ethics_hours: number; jurisdiction_name: string }
> = {
  CA: { hours_per_cycle: 25, cycle_years: 1, ethics_hours: 4, jurisdiction_name: 'California' },
  NY: { hours_per_cycle: 24, cycle_years: 2, ethics_hours: 4, jurisdiction_name: 'New York' },
  TX: { hours_per_cycle: 15, cycle_years: 1, ethics_hours: 3, jurisdiction_name: 'Texas' },
  FL: { hours_per_cycle: 33, cycle_years: 3, ethics_hours: 5, jurisdiction_name: 'Florida' },
  IL: { hours_per_cycle: 30, cycle_years: 2, ethics_hours: 6, jurisdiction_name: 'Illinois' },
  PA: { hours_per_cycle: 12, cycle_years: 1, ethics_hours: 2, jurisdiction_name: 'Pennsylvania' },
  OH: { hours_per_cycle: 24, cycle_years: 2, ethics_hours: 2.5, jurisdiction_name: 'Ohio' },
  GA: { hours_per_cycle: 12, cycle_years: 1, ethics_hours: 1, jurisdiction_name: 'Georgia' },
  NC: { hours_per_cycle: 12, cycle_years: 1, ethics_hours: 2, jurisdiction_name: 'North Carolina' },
  MI: { hours_per_cycle: 0, cycle_years: 0, ethics_hours: 0, jurisdiction_name: 'Michigan' },
};

export class CleComplianceTab {
  private readonly arkovaApiKey: string;
  private readonly arkovaBaseUrl: string;

  constructor(arkovaApiKey: string, arkovaBaseUrl?: string) {
    this.arkovaApiKey = arkovaApiKey;
    this.arkovaBaseUrl = (arkovaBaseUrl ?? ARKOVA_DEFAULT_URL).replace(/\/+$/, '');
  }

  /**
   * Look up bar status and CLE compliance for an attorney.
   *
   * Queries Arkova's CLE verification endpoint which cross-references
   * bar number against state bar association records.
   */
  async lookupBarStatus(
    barNumber: string,
    jurisdiction: string,
  ): Promise<CleStatus> {
    const response = await fetch(
      `${this.arkovaBaseUrl}/api/v1/cle/verify?bar_number=${encodeURIComponent(barNumber)}&jurisdiction=${encodeURIComponent(jurisdiction)}`,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.arkovaApiKey,
        },
      },
    );

    if (response.status === 404) {
      return {
        attorney_name: '',
        bar_number: barNumber,
        jurisdiction,
        status: 'UNKNOWN',
        cle_hours_required: 0,
        cle_hours_completed: 0,
        cle_hours_remaining: 0,
        next_deadline: null,
        ethics_hours_required: 0,
        ethics_hours_completed: 0,
      };
    }

    if (!response.ok) {
      throw new Error(`CLE lookup failed: HTTP ${response.status}`);
    }

    const data = await response.json() as Record<string, any>;

    const req = CLE_REQUIREMENTS[jurisdiction.toUpperCase()] ?? {
      hours_per_cycle: 0,
      cycle_years: 0,
      ethics_hours: 0,
    };

    return {
      attorney_name: data.attorney_name ?? '',
      bar_number: data.bar_number ?? barNumber,
      jurisdiction: data.jurisdiction ?? jurisdiction,
      status: data.status ?? 'UNKNOWN',
      cle_hours_required: data.cle_hours_required ?? req.hours_per_cycle,
      cle_hours_completed: data.cle_hours_completed ?? 0,
      cle_hours_remaining: data.cle_hours_remaining ?? req.hours_per_cycle,
      next_deadline: data.next_deadline ?? null,
      ethics_hours_required: data.ethics_hours_required ?? req.ethics_hours,
      ethics_hours_completed: data.ethics_hours_completed ?? 0,
      arkova_verification: data.public_id
        ? {
            public_id: data.public_id,
            verified: data.verified ?? false,
            anchor_timestamp: data.anchor_timestamp ?? '',
            record_uri: data.record_uri ?? '',
          }
        : undefined,
    };
  }

  /**
   * Get CLE requirements for a jurisdiction.
   */
  getRequirements(jurisdiction: string): {
    hours_per_cycle: number;
    cycle_years: number;
    ethics_hours: number;
    jurisdiction_name: string;
  } | null {
    return CLE_REQUIREMENTS[jurisdiction.toUpperCase()] ?? null;
  }

  /**
   * Get all supported jurisdictions.
   */
  getSupportedJurisdictions(): string[] {
    return Object.keys(CLE_REQUIREMENTS);
  }
}
