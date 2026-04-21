/**
 * Cloudflare Load Balancer — Worker Tunnel Health Checks
 *
 * Configures a Cloudflare Load Balancer with:
 *   - Origin pool pointing to worker tunnel endpoints
 *   - Active health checks on /api/health (GET, expect 200 + "healthy")
 *   - Failover policy for high availability
 *
 * Prerequisites:
 *   - Cloudflare account with Load Balancing add-on
 *   - CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID env vars set
 *   - Cloudflare Tunnels already configured (INFRA-01)
 *
 * Usage: npx tsx infra/cloudflare/load-balancer.ts
 */

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

interface HealthMonitor {
  type: 'http';
  description: string;
  method: 'GET';
  path: string;
  port: number;
  expected_codes: string;
  expected_body: string;
  interval: number;
  retries: number;
  timeout: number;
  follow_redirects: boolean;
  allow_insecure: boolean;
  header: Record<string, string[]>;
}

interface OriginPool {
  name: string;
  description: string;
  enabled: boolean;
  monitor: string;
  notification_email: string;
  origins: PoolOrigin[];
  origin_steering: {
    policy: string;
  };
}

interface PoolOrigin {
  name: string;
  address: string;
  enabled: boolean;
  weight: number;
  header: {
    Host: string[];
  };
}

interface LoadBalancer {
  name: string;
  description: string;
  proxied: boolean;
  ttl: number;
  steering_policy: string;
  default_pools: string[];
  fallback_pool: string;
  session_affinity: string;
  session_affinity_ttl: number;
}

async function cfFetch<T>(
  path: string,
  method: string,
  body?: unknown,
  useZone = false,
): Promise<T> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    throw new Error(
      'Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN environment variables',
    );
  }

  const base = useZone
    ? `${CLOUDFLARE_API}/zones/${zoneId}`
    : `${CLOUDFLARE_API}/accounts/${accountId}`;

  const url = `${base}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await res.json()) as { success: boolean; result: T; errors: unknown[] };
  if (!data.success) {
    throw new Error(`Cloudflare API error: ${JSON.stringify(data.errors)}`);
  }

  return data.result;
}

// ---------------------------------------------------------------------------
// Step 1: Create Health Monitor
// ---------------------------------------------------------------------------

async function createHealthMonitor(): Promise<string> {
  const monitor: HealthMonitor = {
    type: 'http',
    description: 'Arkova Worker /api/health check',
    method: 'GET',
    path: '/health',
    port: 443,
    expected_codes: '200',
    expected_body: 'healthy',
    interval: 30, // Check every 30 seconds
    retries: 2, // 2 retries before marking unhealthy
    timeout: 5, // 5 second timeout per check
    follow_redirects: true,
    allow_insecure: false,
    header: {
      'User-Agent': ['Cloudflare-HealthCheck/Arkova'],
    },
  };

  console.log('[LB] Creating health monitor...');
  const result = await cfFetch<{ id: string }>(
    '/load_balancers/monitors',
    'POST',
    monitor,
  );

  console.log(`[LB] Health monitor created: ${result.id}`);
  return result.id;
}

// ---------------------------------------------------------------------------
// Step 2: Create Origin Pool
// ---------------------------------------------------------------------------

async function createOriginPool(monitorId: string): Promise<string> {
  const workerHost = process.env.WORKER_TUNNEL_HOSTNAME ?? 'worker.arkova.ai';
  const notificationEmail =
    process.env.NOTIFICATION_EMAIL ?? 'ops@arkova.ai';

  const pool: OriginPool = {
    name: 'arkova-worker-pool',
    description: 'Arkova Worker instances behind Cloudflare Tunnels',
    enabled: true,
    monitor: monitorId,
    notification_email: notificationEmail,
    origins: [
      {
        name: 'worker-primary',
        address: workerHost,
        enabled: true,
        weight: 1,
        header: {
          Host: [workerHost],
        },
      },
    ],
    origin_steering: {
      policy: 'random', // Random distribution across healthy origins
    },
  };

  console.log('[LB] Creating origin pool...');
  const result = await cfFetch<{ id: string }>(
    '/load_balancers/pools',
    'POST',
    pool,
  );

  console.log(`[LB] Origin pool created: ${result.id}`);
  return result.id;
}

// ---------------------------------------------------------------------------
// Step 3: Create Load Balancer
// ---------------------------------------------------------------------------

async function createLoadBalancer(poolId: string): Promise<string> {
  const lbHostname = process.env.LB_HOSTNAME ?? 'api.arkova.ai';

  const lb: LoadBalancer = {
    name: lbHostname,
    description: 'Arkova Worker Load Balancer with active health checks',
    proxied: true,
    ttl: 30,
    steering_policy: 'random',
    default_pools: [poolId],
    fallback_pool: poolId,
    session_affinity: 'none',
    session_affinity_ttl: 0,
  };

  console.log('[LB] Creating load balancer...');
  const result = await cfFetch<{ id: string }>(
    '/load_balancers',
    'POST',
    lb,
    true, // zone-level resource
  );

  console.log(`[LB] Load balancer created: ${result.id}`);
  return result.id;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Cloudflare Load Balancer Configuration ===');
  console.log('Setting up HA with active health checks on /health...\n');

  if (!process.env.CLOUDFLARE_ZONE_ID) {
    throw new Error(
      'CLOUDFLARE_ZONE_ID required for load balancer creation',
    );
  }

  const monitorId = await createHealthMonitor();
  const poolId = await createOriginPool(monitorId);
  const lbId = await createLoadBalancer(poolId);

  console.log('\n=== Configuration Complete ===');
  console.log(`Health Monitor ID: ${monitorId}`);
  console.log(`Origin Pool ID:    ${poolId}`);
  console.log(`Load Balancer ID:  ${lbId}`);
  console.log(
    '\nVerify in Cloudflare Dashboard: Traffic > Load Balancing',
  );
  console.log(
    'Health check status: Traffic > Load Balancing > Manage Pools > arkova-worker-pool',
  );
}

main().catch((err) => {
  console.error('[LB] Configuration failed:', err);
  process.exit(1);
});
