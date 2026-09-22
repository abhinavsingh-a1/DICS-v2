#!/usr/bin/env bash
# Generates genesis.json and 4 validator key directories for a local
# IBFT2.0 Besu network, using Besu's own operator tool so keys and the
# genesis extraData are guaranteed consistent (hand-crafting these is
# error-prone and not worth doing manually).
#
# Usage: ./generate-network.sh
# Output: ./networkFiles/  (genesis.json + keys/<address>/key, key.pub per node)

set -euo pipefail

OUT_DIR="./networkFiles"
rm -rf "${OUT_DIR}"

docker run --rm \
  -v "$(pwd):/config" \
  hyperledger/besu:latest \
  operator generate-blockchain-config \
  --config-file=/config/ibftConfigFile.json \
  --to=/config/networkFiles \
  --private-key-file-name=key

echo ""
echo "Generated network files in ${OUT_DIR}"
echo "Validator addresses (also embedded in genesis extraData):"
ls "${OUT_DIR}/keys"

echo ""
echo "Next: docker compose up -d"
