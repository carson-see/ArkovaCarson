import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const dockerfile = readFileSync(
  join(root, 'scripts/staging/rig-b1-bitcoin-core-image.Dockerfile'),
  'utf8',
);
const buildScript = readFileSync(
  join(root, 'scripts/staging/build-rig-b1-bitcoin-core-image.sh'),
  'utf8',
);
const sourceSha = 'b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e';
const baseSha = '7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818';
const frontendSha = 'a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e';

describe('RIG-B1 immutable Bitcoin Core image', () => {
  it('pins the reviewed 31.1 archive and verifies it inside the build', () => {
    expect(dockerfile).toContain(`# syntax=docker/dockerfile:1.7@sha256:${frontendSha}`);
    expect(dockerfile).toContain('BITCOIN_CORE_VERSION=31.1');
    expect(dockerfile).toContain(`BITCOIN_CORE_ARCHIVE_SHA256=${sourceSha}`);
    expect(dockerfile).toContain('sha256sum --check --strict');
    expect(dockerfile).toContain('Bitcoin Core daemon version v${BITCOIN_CORE_VERSION}.0');
    expect(buildScript).toContain(`BITCOIN_CORE_SHA256="${sourceSha}"`);
    expect(buildScript).toContain('shasum -a 256');
  });

  it('uses one digest-pinned verification stage and a package-free scratch runtime', () => {
    const fromLines = dockerfile.split('\n').filter((line) => line.startsWith('FROM '));
    expect(fromLines).toHaveLength(2);
    expect(fromLines).toEqual([
      expect.stringMatching(`^FROM debian@sha256:${baseSha} AS verify$`),
      'FROM scratch',
    ]);
    expect(dockerfile).not.toMatch(/\bapt(?:-get)?\b/);
    expect(dockerfile).toContain('COPY --from=verify /rootfs /');
    expect(dockerfile).toContain('libnss_dns.so.2');
    expect(dockerfile).toContain('hosts: files dns');
  });

  it('ships only the daemon and CLI, runs unprivileged, and exposes no RPC port', () => {
    expect(dockerfile).toContain('/bin/bitcoind');
    expect(dockerfile).toContain('/bin/bitcoin-cli');
    expect(dockerfile).toContain('USER 10001:10001');
    expect(dockerfile).toContain('EXPOSE 38333');
    expect(dockerfile).not.toContain('EXPOSE 38332');
    expect(dockerfile).not.toContain('bitcoin-qt');
  });

  it('is build-only and rejects latest rather than publishing implicitly', () => {
    expect(buildScript).toContain('--load');
    expect(buildScript).not.toContain('--push');
    expect(buildScript).toContain('|| "$TAG" == *:latest');
    expect(buildScript).not.toMatch(/docker\s+push/);
  });
});
