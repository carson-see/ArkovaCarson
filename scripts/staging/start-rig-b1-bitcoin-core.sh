#!/usr/bin/env bash
# Bootstrap the temporary RIG-B1 Bitcoin Core Signet node on Container-Optimized OS.
# Secret values are fetched by the node's dedicated service account and never
# enter instance metadata, command-line arguments, logs, or the container env.

set -euo pipefail

METADATA_ROOT="http://metadata.google.internal/computeMetadata/v1"
METADATA_HEADER="Metadata-Flavor: Google"

metadata() {
  /usr/bin/curl --fail --silent --show-error \
    --header "$METADATA_HEADER" \
    "${METADATA_ROOT}/instance/attributes/$1"
}

PROJECT_ID="$(metadata gcp-project-id)"
BITCOIN_CORE_IMAGE="$(metadata bitcoin-core-image)"
RPC_AUTH_SECRET="$(metadata rpc-auth-secret)"
RPC_AUTH_SECRET_VERSION="$(metadata rpc-auth-secret-version)"
RPC_BIND="$(metadata rpc-bind)"
RPC_ALLOW_CIDR="$(metadata rpc-allow-cidr)"
DATA_DISK_NAME="$(metadata data-disk-name)"
TREASURY_ADDRESS="$(metadata treasury-address)"
TREASURY_DESCRIPTOR="$(metadata treasury-descriptor)"
TREASURY_SPLIT_PLAN_DIGEST="$(metadata treasury-split-plan-digest)"
TREASURY_SPLIT_TXID="$(metadata treasury-split-txid)"
TREASURY_EXPECTED_OUTPUT_COUNT="$(metadata treasury-expected-output-count)"
TREASURY_EXPECTED_TOTAL_SATS="$(metadata treasury-expected-total-sats)"
TREASURY_ORIGINAL_SPLIT_UNSPENT_OUTPUT_COUNT="$(metadata treasury-original-split-unspent-output-count)"
TREASURY_FUNDED_PROBE_TXID="$(metadata treasury-funded-probe-txid)"
TREASURY_FUNDED_PROBE_CHANGE_VOUT="$(metadata treasury-funded-probe-change-vout)"
TREASURY_FUNDED_PROBE_CHANGE_VALUE_SATS="$(metadata treasury-funded-probe-change-value-sats)"
BITCOIN_CORE_VERSION="$(metadata bitcoin-core-version)"
BITCOIN_CORE_SOURCE_SHA256="$(metadata bitcoin-core-source-sha256)"
REGISTRY_HOST="${BITCOIN_CORE_IMAGE%%/*}"

if [[ ! "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ \
  || "$BITCOIN_CORE_IMAGE" != "us-central1-docker.pkg.dev/arkova1/arkova-worker-images/bitcoin-core-signet@sha256:cdc306adc6ef6017326681ff09c4d3247ce77026bed17feccdc163a96519c8f8" \
  || "$REGISTRY_HOST" != "us-central1-docker.pkg.dev" \
  || ! "$RPC_AUTH_SECRET" =~ ^[A-Za-z][A-Za-z0-9_-]{0,254}$ \
  || ! "$RPC_AUTH_SECRET_VERSION" =~ ^[1-9][0-9]*$ \
  || ! "$RPC_BIND" =~ ^10[.]33[.]10[.]10$ \
  || ! "$RPC_ALLOW_CIDR" =~ ^10[.]33[.]11[.]0/28$ \
  || ! "$DATA_DISK_NAME" =~ ^[a-z][a-z0-9-]{2,62}$ \
  || ! "$TREASURY_ADDRESS" =~ ^tb1[a-z0-9]{20,87}$ \
  || ! "$TREASURY_DESCRIPTOR" =~ ^addr\(${TREASURY_ADDRESS}\)#[a-z0-9]{8}$ \
  || "$TREASURY_SPLIT_PLAN_DIGEST" != "sha256:9808e07f3b2329488e5dc5f2658a2224937f3c950fd7322b9a5a227ff34fc034" \
  || "$TREASURY_SPLIT_TXID" != "1f7a9f92e15fd43c853cd4fe042e6400fac35f0df01569e421913dc2d9a67941" \
  || "$TREASURY_EXPECTED_OUTPUT_COUNT" != "32" \
  || "$TREASURY_EXPECTED_TOTAL_SATS" != "169482" \
  || "$TREASURY_ORIGINAL_SPLIT_UNSPENT_OUTPUT_COUNT" != "31" \
  || "$TREASURY_FUNDED_PROBE_TXID" != "4f56c2bd94b4205a83b3625d52fc35db3ef2a8937d178cd519145f3055ffe8f6" \
  || "$TREASURY_FUNDED_PROBE_CHANGE_VOUT" != "1" \
  || "$TREASURY_FUNDED_PROBE_CHANGE_VALUE_SATS" != "5145" \
  || "$BITCOIN_CORE_VERSION" != "31.1" \
  || "$BITCOIN_CORE_SOURCE_SHA256" != "b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e" ]]; then
  echo "RIG-B1 node metadata failed the immutable allowlist." >&2
  exit 2
fi

ACCESS_TOKEN="$(/usr/bin/curl --fail --silent --show-error \
  --header "$METADATA_HEADER" \
  "${METADATA_ROOT}/instance/service-accounts/default/token" \
  | /usr/bin/sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "RIG-B1 node could not obtain its metadata access token." >&2
  exit 1
fi

SECRET_RESPONSE="$(/usr/bin/curl --fail --silent --show-error \
  --header "Authorization: Bearer ${ACCESS_TOKEN}" \
  "https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/${RPC_AUTH_SECRET}/versions/${RPC_AUTH_SECRET_VERSION}:access")"
SECRET_B64="$(printf '%s' "$SECRET_RESPONSE" \
  | /usr/bin/tr -d '\n' \
  | /usr/bin/sed -n 's/.*"data"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_+\/=\-]*\)".*/\1/p')"
unset ACCESS_TOKEN SECRET_RESPONSE
RPC_AUTH="$(printf '%s' "$SECRET_B64" | /usr/bin/base64 --decode)"
unset SECRET_B64
if [[ "$RPC_AUTH" != *:* || "$RPC_AUTH" == *$'\n'* || "$RPC_AUTH" == *$'\r'* ]]; then
  echo "RIG-B1 node RPC auth secret must be one bounded username:password value." >&2
  exit 1
fi
RPC_USER="${RPC_AUTH%%:*}"
RPC_PASSWORD="${RPC_AUTH#*:}"
unset RPC_AUTH
if [[ ! "$RPC_USER" =~ ^[A-Za-z0-9._-]{1,64}$ || ${#RPC_PASSWORD} -lt 32 || ${#RPC_PASSWORD} -gt 256 ]]; then
  echo "RIG-B1 node RPC auth secret failed the bounded credential shape." >&2
  exit 1
fi

DATA_DEVICE="/dev/disk/by-id/google-${DATA_DISK_NAME}"
for _ in $(/usr/bin/seq 1 60); do
  [[ -b "$DATA_DEVICE" ]] && break
  /usr/bin/sleep 1
done
if [[ ! -b "$DATA_DEVICE" ]]; then
  echo "RIG-B1 data disk did not attach." >&2
  exit 1
fi
if ! /sbin/blkid "$DATA_DEVICE" >/dev/null 2>&1; then
  /sbin/mkfs.ext4 -F "$DATA_DEVICE" >/dev/null
fi
DATA_ROOT="/var/lib/arkova-rig-b1-bitcoin"
/usr/bin/mkdir -p "$DATA_ROOT"
if ! /bin/mountpoint -q "$DATA_ROOT"; then
  /bin/mount -o nodev,nosuid "$DATA_DEVICE" "$DATA_ROOT"
fi
/usr/bin/mkdir -p "$DATA_ROOT/.bitcoin"
/bin/chmod 0700 "$DATA_ROOT/.bitcoin"

CONFIG_PATH="$DATA_ROOT/.bitcoin/bitcoin.conf"
umask 077
{
  printf '%s\n' 'signet=1' 'server=1' 'txindex=1' 'listen=1' 'disablewallet=0'
  printf '%s\n' 'rpcbind=127.0.0.1' 'rpcallowip=127.0.0.1/32'
  printf 'rpcbind=%s\n' "$RPC_BIND"
  printf 'rpcallowip=%s\n' "$RPC_ALLOW_CIDR"
  printf 'rpcuser=%s\n' "$RPC_USER"
  printf 'rpcpassword=%s\n' "$RPC_PASSWORD"
} >"$CONFIG_PATH"
unset RPC_USER RPC_PASSWORD
# The reviewed scratch image runs as the fixed non-root UID:GID 10001:10001.
# Ownership is corrected after the root-created config is complete so both the
# config and future cookie/blocks/chainstate writes are accessible.
/bin/chown -R 10001:10001 "$DATA_ROOT"

# Authenticate to the one approved Artifact Registry host using a fresh
# metadata OAuth token. DOCKER_CONFIG lives on /run (tmpfs), so the credential
# never reaches persistent disk; the token is never an argv or log value.
DOCKER_CONFIG="/run/arkova-rig-b1-docker-auth"
export DOCKER_CONFIG
/usr/bin/rm -rf -- "$DOCKER_CONFIG"
/usr/bin/mkdir -m 0700 "$DOCKER_CONFIG"
REGISTRY_TOKEN="$(/usr/bin/curl --fail --silent --show-error \
  --header "$METADATA_HEADER" \
  "${METADATA_ROOT}/instance/service-accounts/default/token" \
  | /usr/bin/sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
if [[ -z "$REGISTRY_TOKEN" ]] || ! printf '%s' "$REGISTRY_TOKEN" \
  | /usr/bin/docker login --username oauth2accesstoken --password-stdin \
    "$REGISTRY_HOST" >/dev/null 2>&1; then
  unset REGISTRY_TOKEN
  /usr/bin/rm -rf -- "$DOCKER_CONFIG"
  echo "RIG-B1 node could not authenticate to its approved Artifact Registry repository." >&2
  exit 1
fi
unset REGISTRY_TOKEN
if ! /usr/bin/docker pull "$BITCOIN_CORE_IMAGE"; then
  /usr/bin/docker logout "$REGISTRY_HOST" >/dev/null 2>&1 || true
  /usr/bin/rm -rf -- "$DOCKER_CONFIG"
  echo "RIG-B1 immutable Bitcoin Core image pull failed." >&2
  exit 1
fi
/usr/bin/docker logout "$REGISTRY_HOST" >/dev/null 2>&1 || true
/usr/bin/rm -rf -- "$DOCKER_CONFIG"
unset DOCKER_CONFIG REGISTRY_HOST
/usr/bin/docker rm -f arkova-rig-b1-bitcoin-core >/dev/null 2>&1 || true
/usr/bin/docker run --detach \
  --name arkova-rig-b1-bitcoin-core \
  --restart=unless-stopped \
  --network=host \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --volume /var/lib/arkova-rig-b1-bitcoin:/home/bitcoin:rw \
  "$BITCOIN_CORE_IMAGE" \
  -signet -conf=/home/bitcoin/.bitcoin/bitcoin.conf

# Create only a descriptor watch-only wallet. The treasury WIF is deliberately
# absent from this VM, its service account grants, metadata, disk, and container.
for _ in $(/usr/bin/seq 1 180); do
  if /usr/bin/docker exec arkova-rig-b1-bitcoin-core \
    bitcoin-cli -signet -rpcwait getblockchaininfo >/dev/null 2>&1; then
    break
  fi
  /usr/bin/sleep 2
done
if ! /usr/bin/docker exec arkova-rig-b1-bitcoin-core \
  bitcoin-cli -signet -rpcwait getblockchaininfo >/dev/null 2>&1; then
  echo "RIG-B1 Bitcoin Core RPC never became locally ready." >&2
  exit 1
fi
if ! /usr/bin/docker exec arkova-rig-b1-bitcoin-core \
  bitcoin-cli -signet listwalletdir \
  | /usr/bin/grep -F 'arkova-watch-only' >/dev/null; then
  /usr/bin/docker exec arkova-rig-b1-bitcoin-core \
    bitcoin-cli -signet createwallet arkova-watch-only true true '' false true true >/dev/null
fi

DESCRIPTOR_INFO="$(/usr/bin/docker exec arkova-rig-b1-bitcoin-core \
  bitcoin-cli -signet -rpcwallet=arkova-watch-only \
  getdescriptorinfo "addr(${TREASURY_ADDRESS})")"
OBSERVED_DESCRIPTOR="$(printf '%s' "$DESCRIPTOR_INFO" \
  | /usr/bin/tr -d '\n' \
  | /usr/bin/sed -n 's/.*"descriptor"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
if [[ "$OBSERVED_DESCRIPTOR" != "$TREASURY_DESCRIPTOR" ]]; then
  echo "RIG-B1 signed watch-only descriptor does not match Bitcoin Core checksum derivation." >&2
  exit 1
fi
IMPORT_RESULT="$(/usr/bin/docker exec arkova-rig-b1-bitcoin-core \
  bitcoin-cli -signet -rpcwallet=arkova-watch-only importdescriptors \
  "[{\"desc\":\"${TREASURY_DESCRIPTOR}\",\"timestamp\":0,\"active\":false,\"label\":\"arkova-treasury-watch-only\"}]")"
if ! printf '%s' "$IMPORT_RESULT" | /usr/bin/grep -Eq '"success"[[:space:]]*:[[:space:]]*true'; then
  echo "RIG-B1 historical watch-only descriptor import/rescan failed." >&2
  exit 1
fi
unset IMPORT_RESULT DESCRIPTOR_INFO OBSERVED_DESCRIPTOR

# Timestamp zero is mandatory: the signed 32-output inventory may predate node
# creation. Admission waits for the historical rescan and then verifies the
# exact count and total before the worker can use this node.
for _ in $(/usr/bin/seq 1 1800); do
  WALLET_INFO="$(/usr/bin/docker exec arkova-rig-b1-bitcoin-core \
    bitcoin-cli -signet -rpcwallet=arkova-watch-only getwalletinfo)"
  if printf '%s' "$WALLET_INFO" | /usr/bin/grep -Eq '"scanning"[[:space:]]*:[[:space:]]*false'; then
    break
  fi
  /usr/bin/sleep 2
done
if ! printf '%s' "${WALLET_INFO:-}" | /usr/bin/grep -Eq '"scanning"[[:space:]]*:[[:space:]]*false' \
  || ! printf '%s' "$WALLET_INFO" | /usr/bin/grep -Eq '"private_keys_enabled"[[:space:]]*:[[:space:]]*false' \
  || ! printf '%s' "$WALLET_INFO" | /usr/bin/grep -Eq '"descriptors"[[:space:]]*:[[:space:]]*true'; then
  echo "RIG-B1 watch-only historical rescan or wallet policy did not reach readiness." >&2
  exit 1
fi
unset WALLET_INFO

CONFIRMED_UTXOS="$(/usr/bin/docker exec arkova-rig-b1-bitcoin-core \
  bitcoin-cli -signet -rpcwallet=arkova-watch-only listunspent \
  1 9999999 "[\"${TREASURY_ADDRESS}\"]" true)"
read -r OBSERVED_OUTPUT_COUNT OBSERVED_TOTAL_SATS \
  OBSERVED_ORIGINAL_COUNT OBSERVED_EXACT_ORIGINAL_COUNT \
  OBSERVED_PROBE_COUNT OBSERVED_EXACT_PROBE_COUNT \
  OBSERVED_OTHER_COUNT OBSERVED_DUPLICATE_COUNT OBSERVED_MISSING_COUNT \
  <<<"$(printf '%s\n' "$CONFIRMED_UTXOS" \
    | /usr/bin/awk \
      -v original="$TREASURY_SPLIT_TXID" \
      -v probe="$TREASURY_FUNDED_PROBE_TXID" \
      -v probe_vout="$TREASURY_FUNDED_PROBE_CHANGE_VOUT" \
      -v probe_sats="$TREASURY_FUNDED_PROBE_CHANGE_VALUE_SATS" '
        /"txid"[[:space:]]*:/ {
          txid=$0
          sub(/^.*"txid"[[:space:]]*:[[:space:]]*"/, "", txid)
          sub(/".*$/, "", txid)
        }
        /"vout"[[:space:]]*:/ {
          vout=$0
          sub(/^.*"vout"[[:space:]]*:[[:space:]]*/, "", vout)
          sub(/,.*/, "", vout)
        }
        /"amount"[[:space:]]*:/ {
          amount=$0
          sub(/^.*"amount"[[:space:]]*:[[:space:]]*/, "", amount)
          sub(/,.*/, "", amount)
          sats=sprintf("%.0f", amount * 100000000)
          vout_num=vout + 0
          key=txid ":" vout_num
          if (seen[key]++ > 0) duplicate_count += 1
          count += 1
          total += sats
          if (txid == original) {
            original_count += 1
            expected_sats=-1
            if ((vout_num >= 0 && vout_num <= 4) || vout_num == 6) expected_sats=5302
            else if (vout_num >= 7 && vout_num <= 31) expected_sats=5301
            if (sats == expected_sats) exact_original_count += 1
          } else if (txid == probe) {
            probe_count += 1
            if (vout_num == probe_vout && sats == probe_sats) exact_probe_count += 1
          } else {
            other_count += 1
          }
        }
        END {
          for (vout=0; vout<=31; vout+=1) {
            if (vout == 5) continue
            if (seen[original ":" vout] != 1) missing_count += 1
          }
          if (seen[probe ":" probe_vout] != 1) missing_count += 1
          printf "%.0f %.0f %.0f %.0f %.0f %.0f %.0f %.0f %.0f", \
            count, total, original_count, exact_original_count, probe_count, \
            exact_probe_count, other_count, duplicate_count, missing_count
        }
      ')"
unset CONFIRMED_UTXOS
if [[ "$OBSERVED_OUTPUT_COUNT" != "$TREASURY_EXPECTED_OUTPUT_COUNT" \
  || "$OBSERVED_TOTAL_SATS" != "$TREASURY_EXPECTED_TOTAL_SATS" \
  || "$OBSERVED_ORIGINAL_COUNT" != "$TREASURY_ORIGINAL_SPLIT_UNSPENT_OUTPUT_COUNT" \
  || "$OBSERVED_EXACT_ORIGINAL_COUNT" != "$TREASURY_ORIGINAL_SPLIT_UNSPENT_OUTPUT_COUNT" \
  || "$OBSERVED_PROBE_COUNT" != "1" \
  || "$OBSERVED_EXACT_PROBE_COUNT" != "1" \
  || "$OBSERVED_OTHER_COUNT" != "0" \
  || "$OBSERVED_DUPLICATE_COUNT" != "0" \
  || "$OBSERVED_MISSING_COUNT" != "0" ]]; then
  echo "RIG-B1 confirmed watch-only inventory does not match the signed current 31+1 treasury plan." >&2
  exit 1
fi

# Do not expose the worker or publish topology ownership until the node proves
# the exact signet/index/split provenance contract. The single compact marker
# below contains no credential and is the only startup output trusted by the
# provisioner's serial-port readiness barrier.
CHAIN_INFO="$(/usr/bin/docker exec arkova-rig-b1-bitcoin-core \
  bitcoin-cli -signet getblockchaininfo)"
OBSERVED_CHAIN="$(printf '%s\n' "$CHAIN_INFO" \
  | /usr/bin/sed -n 's/.*"chain"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
OBSERVED_BLOCKS="$(printf '%s\n' "$CHAIN_INFO" \
  | /usr/bin/sed -n 's/.*"blocks"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
OBSERVED_HEADERS="$(printf '%s\n' "$CHAIN_INFO" \
  | /usr/bin/sed -n 's/.*"headers"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
if [[ "$OBSERVED_CHAIN" != "signet" \
  || ! "$OBSERVED_BLOCKS" =~ ^[0-9]+$ \
  || ! "$OBSERVED_HEADERS" =~ ^[0-9]+$ \
  || ! "$CHAIN_INFO" =~ \"initialblockdownload\"[[:space:]]*:[[:space:]]*false ]]; then
  echo "RIG-B1 signet chain did not reach a non-IBD indexed readiness point." >&2
  exit 1
fi
if (( 10#$OBSERVED_HEADERS < 10#$OBSERVED_BLOCKS )); then
  echo "RIG-B1 signet headers cannot lag the admitted block height." >&2
  exit 1
fi

SIGNET_GENESIS_HASH="$(/usr/bin/docker exec arkova-rig-b1-bitcoin-core \
  bitcoin-cli -signet getblockhash 0 | /usr/bin/tr -d '\r\n"')"
if [[ "$SIGNET_GENESIS_HASH" != "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6" ]]; then
  echo "RIG-B1 node is not bound to the exact Bitcoin Signet genesis." >&2
  exit 1
fi

TXINDEX_INFO="$(/usr/bin/docker exec arkova-rig-b1-bitcoin-core \
  bitcoin-cli -signet getindexinfo txindex)"
TXINDEX_BEST_BLOCK_HEIGHT="$(printf '%s\n' "$TXINDEX_INFO" \
  | /usr/bin/sed -n 's/.*"best_block_height"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
if [[ ! "$TXINDEX_INFO" =~ \"txindex\" \
  || ! "$TXINDEX_INFO" =~ \"synced\"[[:space:]]*:[[:space:]]*true \
  || ! "$TXINDEX_BEST_BLOCK_HEIGHT" =~ ^[0-9]+$ \
  || "$TXINDEX_BEST_BLOCK_HEIGHT" != "$OBSERVED_BLOCKS" ]]; then
  echo "RIG-B1 txindex did not synchronize to the admitted chain height." >&2
  exit 1
fi

SPLIT_TRANSACTION="$(/usr/bin/docker exec arkova-rig-b1-bitcoin-core \
  bitcoin-cli -signet getrawtransaction "$TREASURY_SPLIT_TXID" true)"
if ! printf '%s\n' "$SPLIT_TRANSACTION" \
  | /usr/bin/grep -Eq "\"txid\"[[:space:]]*:[[:space:]]*\"${TREASURY_SPLIT_TXID}\""; then
  echo "RIG-B1 txindex could not re-observe the signed treasury split transaction." >&2
  exit 1
fi
SPLIT_BLOCK_HASH="$(printf '%s\n' "$SPLIT_TRANSACTION" \
  | /usr/bin/sed -n 's/.*"blockhash"[[:space:]]*:[[:space:]]*"\([0-9a-f][0-9a-f]*\)".*/\1/p')"
unset SPLIT_TRANSACTION
if [[ ! "$SPLIT_BLOCK_HASH" =~ ^[0-9a-f]{64}$ ]]; then
  echo "RIG-B1 split transaction has no exact confirmed block binding." >&2
  exit 1
fi

SPLIT_BLOCK_HEADER="$(/usr/bin/docker exec arkova-rig-b1-bitcoin-core \
  bitcoin-cli -signet getblockheader "$SPLIT_BLOCK_HASH" false \
  | /usr/bin/tr -d '\r\n"')"
SPLIT_TXOUT_PROOF="$(/usr/bin/docker exec arkova-rig-b1-bitcoin-core \
  bitcoin-cli -signet gettxoutproof "[\"${TREASURY_SPLIT_TXID}\"]" "$SPLIT_BLOCK_HASH" \
  | /usr/bin/tr -d '\r\n"')"
if [[ ! "$SPLIT_BLOCK_HEADER" =~ ^[0-9a-f]{160}$ \
  || ! "$SPLIT_TXOUT_PROOF" =~ ^([0-9a-f]{2})+$ ]]; then
  echo "RIG-B1 split transaction proof/header provenance is malformed." >&2
  exit 1
fi

printf -v READY_JSON \
  '{"schemaVersion":"arkova.s33.rig-b1.node-readiness/v1","bitcoinCoreVersion":"%s","bitcoinCoreImage":"%s","sourceTarballSha256":"%s","chain":"signet","initialBlockDownload":false,"blocks":%s,"headers":%s,"genesisHash":"%s","txindexSynced":true,"txindexBestBlockHeight":%s,"treasurySplitPlanDigest":"%s","splitTransactionId":"%s","confirmedOutputCount":%s,"confirmedTotalSats":%s,"splitBlockHash":"%s","splitBlockHeader":"%s","txOutProof":"%s"}' \
  "$BITCOIN_CORE_VERSION" "$BITCOIN_CORE_IMAGE" "$BITCOIN_CORE_SOURCE_SHA256" \
  "$OBSERVED_BLOCKS" "$OBSERVED_HEADERS" "$SIGNET_GENESIS_HASH" \
  "$TXINDEX_BEST_BLOCK_HEIGHT" "$TREASURY_SPLIT_PLAN_DIGEST" "$TREASURY_SPLIT_TXID" \
  "$OBSERVED_OUTPUT_COUNT" "$OBSERVED_TOTAL_SATS" "$SPLIT_BLOCK_HASH" \
  "$SPLIT_BLOCK_HEADER" "$SPLIT_TXOUT_PROOF"
printf 'ARKOVA_RIG_B1_READY_V1 %s\n' "$READY_JSON"
unset CHAIN_INFO TXINDEX_INFO READY_JSON OBSERVED_OUTPUT_COUNT OBSERVED_TOTAL_SATS
unset OBSERVED_TXID_COUNT OBSERVED_MATCHING_TXID_COUNT
