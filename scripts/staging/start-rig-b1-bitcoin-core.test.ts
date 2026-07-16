import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'start-rig-b1-bitcoin-core.sh'), 'utf8');

describe('RIG-B1 Bitcoin Core startup boundary', () => {
  it('authenticates to the exact private Artifact Registry before pull and readiness', () => {
    expect(source).toContain('us-central1-docker.pkg.dev/arkova1/arkova-worker-images/bitcoin-core-signet@sha256:');
    expect(source).toContain('--password-stdin');
    expect(source).toContain('DOCKER_CONFIG="/run/arkova-rig-b1-docker-auth"');
    expect(source).toContain('/usr/bin/docker logout "$REGISTRY_HOST"');
    expect(source).not.toMatch(/docker login[^\n]*\$REGISTRY_TOKEN/);

    const login = source.indexOf('/usr/bin/docker login');
    const pull = source.indexOf('/usr/bin/docker pull');
    const run = source.indexOf('/usr/bin/docker run');
    const readiness = source.indexOf('bitcoin-cli -signet -rpcwait getblockchaininfo');
    expect(login).toBeGreaterThan(0);
    expect(login).toBeLessThan(pull);
    expect(pull).toBeLessThan(run);
    expect(run).toBeLessThan(readiness);
  });

  it('makes the fixed non-root image user the owner before container start', () => {
    const configWrite = source.indexOf('>"$CONFIG_PATH"');
    const chown = source.indexOf('/bin/chown -R 10001:10001 "$DATA_ROOT"');
    const run = source.indexOf('/usr/bin/docker run');
    expect(configWrite).toBeGreaterThan(0);
    expect(configWrite).toBeLessThan(chown);
    expect(chown).toBeLessThan(run);
  });

  it('binds local CLI plus the private connector endpoint and never a public RPC interface', () => {
    expect(source).toContain("'rpcbind=127.0.0.1' 'rpcallowip=127.0.0.1/32'");
    expect(source).toContain("printf 'rpcbind=%s\\n' \"$RPC_BIND\"");
    expect(source).toContain("printf 'rpcallowip=%s\\n' \"$RPC_ALLOW_CIDR\"");
    expect(source).not.toContain('rpcbind=0.0.0.0');
    expect(source).not.toContain('rpcallowip=0.0.0.0/0');
  });

  it('imports only the checksummed public addr descriptor and never accepts a WIF', () => {
    expect(source).toContain('getdescriptorinfo "addr(${TREASURY_ADDRESS})"');
    expect(source).toContain('importdescriptors');
    expect(source).toContain('\\"timestamp\\":0');
    expect(source).toContain('\\"active\\":false');
    expect(source).toContain('TREASURY_DESCRIPTOR="$(metadata treasury-descriptor)"');
    expect(source).toContain('listunspent');
    expect(source).toContain('TREASURY_EXPECTED_OUTPUT_COUNT');
    expect(source).toContain('TREASURY_EXPECTED_TOTAL_SATS');
    expect(source).not.toContain('\\"timestamp\\":\\"now\\"');
    expect(source).not.toContain('BITCOIN_TREASURY_WIF');
    expect(source).not.toContain('importprivkey');
  });

  it('fails closed on the exact reviewed image, source, split transaction, and treasury total', () => {
    expect(source).toContain('cdc306adc6ef6017326681ff09c4d3247ce77026bed17feccdc163a96519c8f8');
    expect(source).toContain('b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e');
    expect(source).toContain('treasury-split-txid');
    expect(source).toContain('1f7a9f92e15fd43c853cd4fe042e6400fac35f0df01569e421913dc2d9a67941');
    expect(source).toContain('TREASURY_EXPECTED_TOTAL_SATS" != "169639"');
    expect(source).toContain('OBSERVED_MATCHING_TXID_COUNT');
  });

  it('proves non-IBD Signet, the exact genesis, synchronized txindex, and immutable transaction provenance', () => {
    expect(source).toContain('initialblockdownload');
    expect(source).toContain('00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6');
    expect(source).toContain('getindexinfo txindex');
    expect(source).toContain('TXINDEX_BEST_BLOCK_HEIGHT" != "$OBSERVED_BLOCKS"');
    expect(source).toContain('getrawtransaction "$TREASURY_SPLIT_TXID" true');
    expect(source).toContain('getblockheader "$SPLIT_BLOCK_HASH" false');
    expect(source).toContain('gettxoutproof');
    expect(source).toContain('^[0-9a-f]{160}$');
    expect(source).toContain('^([0-9a-f]{2})+$');
  });

  it('emits one compact nonsecret serial readiness marker only after all provenance checks', () => {
    const inventoryCheck = source.indexOf('OBSERVED_MATCHING_TXID_COUNT');
    const txIndexCheck = source.indexOf('getindexinfo txindex');
    const proofCheck = source.indexOf('gettxoutproof');
    const marker = source.indexOf("printf 'ARKOVA_RIG_B1_READY_V1 %s\\n'");
    expect(inventoryCheck).toBeGreaterThan(0);
    expect(txIndexCheck).toBeGreaterThan(inventoryCheck);
    expect(proofCheck).toBeGreaterThan(txIndexCheck);
    expect(marker).toBeGreaterThan(proofCheck);
    expect(source).toContain('arkova.s33.rig-b1.node-readiness/v1');
    expect(source).not.toMatch(/READY_JSON[^\n]*(RPC_PASSWORD|RPC_AUTH|ACCESS_TOKEN)/);
  });
});
