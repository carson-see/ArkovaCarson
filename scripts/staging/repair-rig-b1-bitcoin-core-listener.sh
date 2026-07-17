#!/usr/bin/env bash
# One bounded recovery for the retained S3.3 RIG-B1 Signet node. This script
# never formats the data disk, creates/imports a wallet, rescans, spends, or
# broadcasts. It only restores the private RPC listener, restarts the exact
# retained container, and proves the already-confirmed 29+3 inventory.

set -euo pipefail
export PATH="/usr/sbin:/usr/bin:/sbin:/bin"
readonly PATH

readonly METADATA_ROOT="http://metadata.google.internal/computeMetadata/v1"
readonly METADATA_HEADER="Metadata-Flavor: Google"
readonly REPAIR_ID="b1-rpc-listener-repair-b568a78c-v1"
readonly INSTANCE_ID="5096051666939306255"
readonly DATA_DISK_NAME="arkova-s33-rig-b1-bitcoin-core-signet-data"
readonly DATA_ROOT="/var/lib/arkova-rig-b1-bitcoin"
readonly CONTAINER_NAME="arkova-rig-b1-bitcoin-core"
readonly BITCOIN_CORE_IMAGE="us-central1-docker.pkg.dev/arkova1/arkova-worker-images/bitcoin-core-signet@sha256:cdc306adc6ef6017326681ff09c4d3247ce77026bed17feccdc163a96519c8f8"
readonly RPC_BIND="10.33.10.10"
readonly RPC_ALLOW_CIDR="10.33.11.0/28"
readonly TREASURY_ADDRESS="tb1qxca7ke7hgguarqxkwwydrfenn8ymnspxq765eq"
readonly SPLIT_TXID="1f7a9f92e15fd43c853cd4fe042e6400fac35f0df01569e421913dc2d9a67941"
readonly CHANGE_TXID_ONE="4f56c2bd94b4205a83b3625d52fc35db3ef2a8937d178cd519145f3055ffe8f6"
readonly CHANGE_TXID_TWO="927fbed8ed300fcdf174545562c7819e3a2d41280c56e2cb312103f0fcb52fce"
readonly CHANGE_TXID_THREE="dcd74029e0c11929933a181d67b1260c50a809e0c9e7ef215b0d647e7ded92a0"

metadata_attribute() {
  /usr/bin/curl --fail --silent --show-error \
    --header "$METADATA_HEADER" \
    "${METADATA_ROOT}/instance/attributes/$1"
}

metadata_value() {
  /usr/bin/curl --fail --silent --show-error \
    --header "$METADATA_HEADER" \
    "${METADATA_ROOT}/$1"
}

observed_repair_id="$(metadata_attribute b1-rpc-repair-id)"
expected_script_sha256="$(metadata_attribute b1-rpc-repair-script-sha256)"
observed_instance_id="$(metadata_value instance/id)"
if [[ "$observed_repair_id" != "$REPAIR_ID" \
  || "$observed_instance_id" != "$INSTANCE_ID" \
  || ! "$expected_script_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "RIG-B1 RPC repair metadata or instance binding failed." >&2
  exit 2
fi
observed_script_sha256="$(sha256sum "$0" | awk '{print $1}')"
if [[ "$observed_script_sha256" != "$expected_script_sha256" ]]; then
  echo "RIG-B1 RPC repair script digest failed closed." >&2
  exit 2
fi

readonly DATA_DEVICE="/dev/disk/by-id/google-${DATA_DISK_NAME}"
for _ in $(seq 1 60); do
  [[ -b "$DATA_DEVICE" ]] && break
  sleep 1
done
if [[ ! -b "$DATA_DEVICE" ]] || ! /sbin/blkid "$DATA_DEVICE" >/dev/null 2>&1; then
  echo "RIG-B1 retained formatted data disk is not attached; refusing recovery." >&2
  exit 1
fi
mkdir -p "$DATA_ROOT"
if ! /bin/mountpoint -q "$DATA_ROOT"; then
  /bin/mount -o nodev,nosuid "$DATA_DEVICE" "$DATA_ROOT"
fi
if [[ "$(findmnt -n -o SOURCE --target "$DATA_ROOT")" != "$(readlink -f "$DATA_DEVICE")" ]]; then
  echo "RIG-B1 data mount does not resolve to the retained exact disk." >&2
  exit 1
fi

readonly CONFIG_PATH="$DATA_ROOT/.bitcoin/bitcoin.conf"
if [[ ! -f "$CONFIG_PATH" \
  || "$(grep -Ec '^rpcuser=[A-Za-z0-9._-]{1,64}$' "$CONFIG_PATH")" != "1" \
  || "$(grep -Ec '^rpcpassword=.{32,256}$' "$CONFIG_PATH")" != "1" ]]; then
  echo "RIG-B1 retained RPC config is absent or malformed." >&2
  exit 1
fi
readonly CONFIG_TMP="$CONFIG_PATH.rpc-repair"
awk '!/^rpcbind=/ && !/^rpcallowip=/' "$CONFIG_PATH" >"$CONFIG_TMP"
{
  printf '%s\n' 'rpcbind=127.0.0.1' 'rpcallowip=127.0.0.1/32'
  printf '%s\n' "rpcbind=${RPC_BIND}" "rpcallowip=${RPC_ALLOW_CIDR}"
} >>"$CONFIG_TMP"
chmod 0600 "$CONFIG_TMP"
chown 10001:10001 "$CONFIG_TMP"
mv -f "$CONFIG_TMP" "$CONFIG_PATH"
if grep -Eq '^(rpcbind=0[.]0[.]0[.]0|rpcallowip=0[.]0[.]0[.]0/0)$' "$CONFIG_PATH"; then
  echo "RIG-B1 RPC repair refuses a public listener." >&2
  exit 1
fi

if [[ "$(/usr/bin/docker image inspect "$BITCOIN_CORE_IMAGE" --format '{{.Architecture}}' 2>/dev/null)" != "amd64" ]]; then
  echo "RIG-B1 retained exact amd64 Bitcoin Core image is unavailable." >&2
  exit 1
fi
/usr/bin/docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
/usr/bin/docker run --detach \
  --name "$CONTAINER_NAME" \
  --restart=unless-stopped \
  --network=host \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --volume "${DATA_ROOT}:/home/bitcoin:rw" \
  "$BITCOIN_CORE_IMAGE" \
  -signet -conf=/home/bitcoin/.bitcoin/bitcoin.conf >/dev/null

for _ in $(seq 1 300); do
  if /usr/bin/docker exec "$CONTAINER_NAME" \
    bitcoin-cli -signet -rpcwait getblockchaininfo >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
if ! /usr/bin/docker exec "$CONTAINER_NAME" \
  bitcoin-cli -signet -rpcwait getblockchaininfo >/dev/null 2>&1; then
  echo "RIG-B1 repaired Bitcoin Core RPC did not become locally ready." >&2
  exit 1
fi
if ! grep -Eq '^[[:space:]]*[0-9]+:[[:space:]]+0A0A210A:95BC[[:space:]].*[[:space:]]0A[[:space:]]' /proc/net/tcp; then
  echo "RIG-B1 exact private RPC listener is not in LISTEN state." >&2
  exit 1
fi

wallets="$(/usr/bin/docker exec "$CONTAINER_NAME" bitcoin-cli -signet listwallets)"
if ! printf '%s\n' "$wallets" | grep -F '"arkova-watch-only"' >/dev/null; then
  wallet_dir="$(/usr/bin/docker exec "$CONTAINER_NAME" bitcoin-cli -signet listwalletdir)"
  if ! printf '%s\n' "$wallet_dir" | grep -F '"name": "arkova-watch-only"' >/dev/null; then
    echo "RIG-B1 retained watch-only wallet is absent; refusing create/import/rescan." >&2
    exit 1
  fi
  /usr/bin/docker exec "$CONTAINER_NAME" bitcoin-cli -signet loadwallet arkova-watch-only >/dev/null
fi
wallet_info="$(/usr/bin/docker exec "$CONTAINER_NAME" \
  bitcoin-cli -signet -rpcwallet=arkova-watch-only getwalletinfo)"
if ! printf '%s\n' "$wallet_info" | grep -Eq '"private_keys_enabled"[[:space:]]*:[[:space:]]*false' \
  || ! printf '%s\n' "$wallet_info" | grep -Eq '"descriptors"[[:space:]]*:[[:space:]]*true' \
  || ! printf '%s\n' "$wallet_info" | grep -Eq '"scanning"[[:space:]]*:[[:space:]]*false'; then
  echo "RIG-B1 retained watch-only wallet policy is not ready." >&2
  exit 1
fi

confirmed_utxos="$(/usr/bin/docker exec "$CONTAINER_NAME" \
  bitcoin-cli -signet -rpcwallet=arkova-watch-only listunspent \
  1 9999999 "[\"${TREASURY_ADDRESS}\"]" true)"
read -r output_count total_sats original_count exact_original_count \
  change_count exact_change_count other_count duplicate_count missing_count \
  <<<"$(printf '%s\n' "$confirmed_utxos" | awk \
    -v original="$SPLIT_TXID" \
    -v change_one="$CHANGE_TXID_ONE" \
    -v change_two="$CHANGE_TXID_TWO" \
    -v change_three="$CHANGE_TXID_THREE" '
      /"txid"[[:space:]]*:/ {
        txid=$0; sub(/^.*"txid"[[:space:]]*:[[:space:]]*"/, "", txid); sub(/".*$/, "", txid)
      }
      /"vout"[[:space:]]*:/ {
        vout=$0; sub(/^.*"vout"[[:space:]]*:[[:space:]]*/, "", vout); sub(/,.*/, "", vout)
      }
      /"amount"[[:space:]]*:/ {
        amount=$0; sub(/^.*"amount"[[:space:]]*:[[:space:]]*/, "", amount); sub(/,.*/, "", amount)
        sats=sprintf("%.0f", amount * 100000000); vout_num=vout + 0; key=txid ":" vout_num
        if (seen[key]++ > 0) duplicate_count += 1
        count += 1; total += sats
        if (txid == original) {
          original_count += 1; expected=-1
          if (vout_num == 0 || vout_num == 2 || vout_num == 3 || vout_num == 6) expected=5302
          else if (vout_num >= 7 && vout_num <= 31) expected=5301
          if (sats == expected) exact_original_count += 1
        } else if (txid == change_one || txid == change_two || txid == change_three) {
          change_count += 1
          if (vout_num == 1 && sats == 5145) exact_change_count += 1
        } else other_count += 1
      }
      END {
        for (vout=0; vout<=31; vout+=1) {
          if (vout == 1 || vout == 4 || vout == 5) continue
          if (seen[original ":" vout] != 1) missing_count += 1
        }
        if (seen[change_one ":1"] != 1) missing_count += 1
        if (seen[change_two ":1"] != 1) missing_count += 1
        if (seen[change_three ":1"] != 1) missing_count += 1
        printf "%.0f %.0f %.0f %.0f %.0f %.0f %.0f %.0f %.0f", \
          count, total, original_count, exact_original_count, change_count, \
          exact_change_count, other_count, duplicate_count, missing_count
      }
    ')"
if [[ "$output_count" != "32" || "$total_sats" != "169168" \
  || "$original_count" != "29" || "$exact_original_count" != "29" \
  || "$change_count" != "3" || "$exact_change_count" != "3" \
  || "$other_count" != "0" || "$duplicate_count" != "0" \
  || "$missing_count" != "0" ]]; then
  echo "RIG-B1 zero-new-spend exact 29+3 inventory guard failed." >&2
  exit 1
fi

chain_info="$(/usr/bin/docker exec "$CONTAINER_NAME" bitcoin-cli -signet getblockchaininfo)"
txindex_info="$(/usr/bin/docker exec "$CONTAINER_NAME" bitcoin-cli -signet getindexinfo txindex)"
if ! printf '%s\n' "$chain_info" | grep -Eq '"chain"[[:space:]]*:[[:space:]]*"signet"' \
  || ! printf '%s\n' "$chain_info" | grep -Eq '"initialblockdownload"[[:space:]]*:[[:space:]]*false' \
  || ! printf '%s\n' "$txindex_info" | grep -Eq '"synced"[[:space:]]*:[[:space:]]*true'; then
  echo "RIG-B1 repaired node is not synchronized on Signet with txindex." >&2
  exit 1
fi

printf 'ARKOVA_RIG_B1_RPC_REPAIR_READY_V1 repair=%s instance=%s script_sha256=%s inventory=32/169168 original=29 change=3 no_new_spend=true rpc=%s:38332\n' \
  "$REPAIR_ID" "$INSTANCE_ID" "$observed_script_sha256" "$RPC_BIND"
