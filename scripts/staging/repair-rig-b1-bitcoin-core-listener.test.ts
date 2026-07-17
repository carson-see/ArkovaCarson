import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, 'repair-rig-b1-bitcoin-core-listener.sh'), 'utf8');

describe('RIG-B1 retained-node RPC listener repair', () => {
  it('binds the exact retained VM, disk, image, and script digest', () => {
    expect(source).toContain('5096051666939306255');
    expect(source).toContain('arkova-s33-rig-b1-bitcoin-core-signet-data');
    expect(source).toContain('cdc306adc6ef6017326681ff09c4d3247ce77026bed17feccdc163a96519c8f8');
    expect(source).toContain('b1-rpc-repair-script-sha256');
    expect(source).toContain('sha256sum "$0"');
  });

  it('never formats, creates, imports, rescans, spends, or broadcasts', () => {
    expect(source).not.toMatch(/mkfs|createwallet|importdescriptors|rescanblockchain/u);
    expect(source).not.toMatch(/sendrawtransaction|sendtoaddress|walletcreatefundedpsbt/u);
    expect(source).toContain('blkid "$DATA_DEVICE"');
    expect(source).toContain('refusing create/import/rescan');
  });

  it('recreates only the retained container on the exact private listener', () => {
    expect(source).toContain('--network=host');
    expect(source).toContain('rpcbind=127.0.0.1');
    expect(source).toContain('rpcbind=${RPC_BIND}');
    expect(source).toContain('rpcallowip=${RPC_ALLOW_CIDR}');
    expect(source).not.toContain('rpcbind=0.0.0.0');
    expect(source).not.toContain('rpcallowip=0.0.0.0/0');
    expect(source).toContain('0A0A210A:95BC');
  });

  it('admits only the immutable 29 original plus three change inventory', () => {
    expect(source).toContain('927fbed8ed300fcdf174545562c7819e3a2d41280c56e2cb312103f0fcb52fce');
    expect(source).toContain('dcd74029e0c11929933a181d67b1260c50a809e0c9e7ef215b0d647e7ded92a0');
    expect(source).toContain('total_sats" != "169168"');
    expect(source).toContain('original_count" != "29"');
    expect(source).toContain('change_count" != "3"');
    expect(source).toContain('no_new_spend=true');
  });
});
