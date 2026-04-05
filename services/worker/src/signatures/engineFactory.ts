/**
 * AdES Engine Factory — Creates a configured engine instance from environment.
 *
 * Reads ADES_* and QTSP_* environment variables to configure the engine.
 * Falls back to mock implementations when USE_MOCKS=true or variables are missing.
 *
 * Story: PH3-ESIG-01 (SCRUM-422)
 */

import { logger } from '../utils/logger.js';
import { createAdesEngine, type AdesEngine } from './adesEngine.js';
import { createHsmBridge, createMockHsmBridge } from './pki/hsmBridge.js';
import { createCertificateManager } from './pki/certificateManager.js';
import { createOcspClient, createMockOcspClient } from './pki/ocspClient.js';
import { createCrlManager, createMockCrlManager } from './pki/crlManager.js';
import { createTrustStore, createMockTrustStore } from './pki/trustStore.js';
import { createRfc3161Client, createMockRfc3161Client } from './timestamp/rfc3161Client.js';
import { createQtspProvider } from './timestamp/qtspProvider.js';
import { createLtvBuilder, createLtvValidator } from './ltv/ltvBuilder.js';
import type { TsaConfig, KmsProvider } from './types.js';
import { DEFAULTS } from './constants.js';

let engineInstance: AdesEngine | null = null;

/**
 * Get or create the singleton AdES engine instance.
 */
export function getAdesEngine(): AdesEngine {
  if (engineInstance) return engineInstance;
  engineInstance = initEngine();
  return engineInstance;
}

/**
 * Reset the engine (for testing).
 */
export function resetAdesEngine(): void {
  engineInstance = null;
}

function initEngine(): AdesEngine {
  const useMocks = process.env.USE_MOCKS === 'true' || process.env.NODE_ENV === 'test';

  // HSM
  const kmsProvider = (process.env.ADES_KMS_PROVIDER || 'aws_kms') as KmsProvider;
  const hsm = useMocks ? createMockHsmBridge() : createHsmBridge(kmsProvider);

  // Certificate manager (always real — uses Node.js crypto)
  const certManager = createCertificateManager();

  // OCSP + CRL
  const ocspCacheTtl = parseInt(process.env.OCSP_CACHE_TTL_SECONDS || String(DEFAULTS.OCSP_CACHE_TTL_SECONDS), 10);
  const crlCacheTtl = parseInt(process.env.CRL_CACHE_TTL_SECONDS || String(DEFAULTS.CRL_CACHE_TTL_SECONDS), 10);
  const ocspClient = useMocks ? createMockOcspClient() : createOcspClient(ocspCacheTtl);
  const crlManager = useMocks ? createMockCrlManager() : createCrlManager(crlCacheTtl);

  // Trust store
  const eutlInterval = parseInt(process.env.EUTL_UPDATE_INTERVAL_HOURS || String(DEFAULTS.EUTL_UPDATE_INTERVAL_HOURS), 10);
  const trustStore = useMocks ? createMockTrustStore() : createTrustStore(eutlInterval);

  // Timestamp service
  let qtspProvider = null;
  const primaryUrl = process.env.QTSP_PRIMARY_URL;
  if (primaryUrl || useMocks) {
    const rfc3161Client = useMocks ? createMockRfc3161Client() : createRfc3161Client();

    const primaryTsa: TsaConfig = {
      name: process.env.QTSP_PRIMARY_NAME || 'DigiCert TSA',
      url: primaryUrl || 'https://timestamp.digicert.com',
      auth: process.env.QTSP_PRIMARY_AUTH,
      qualified: true,
      timeoutMs: parseInt(process.env.QTSP_TIMEOUT_MS || String(DEFAULTS.TSA_TIMEOUT_MS), 10),
    };

    const secondaryUrl = process.env.QTSP_SECONDARY_URL;
    const secondaryTsa: TsaConfig | null = secondaryUrl ? {
      name: process.env.QTSP_SECONDARY_NAME || 'Sectigo TSA',
      url: secondaryUrl,
      auth: process.env.QTSP_SECONDARY_AUTH,
      qualified: true,
      timeoutMs: parseInt(process.env.QTSP_TIMEOUT_MS || String(DEFAULTS.TSA_TIMEOUT_MS), 10),
    } : null;

    qtspProvider = createQtspProvider(rfc3161Client, primaryTsa, secondaryTsa);
  }

  // LTV
  const ltvBuilder = createLtvBuilder(certManager, ocspClient, crlManager);
  const ltvValidator = createLtvValidator();

  logger.info('AdES engine initialized', {
    kmsProvider: useMocks ? 'mock' : kmsProvider,
    qtspConfigured: !!qtspProvider,
    useMocks,
  });

  return createAdesEngine({
    hsm,
    certManager,
    ocspClient,
    crlManager,
    trustStore,
    qtspProvider,
    ltvBuilder,
    ltvValidator,
  });
}
