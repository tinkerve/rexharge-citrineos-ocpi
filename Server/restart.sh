#!/bin/bash
# SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
# SPDX-License-Identifier: Apache-2.0

set -e  # stop on first error
echo "[nodemon] Change detected in: $1"

# Rebuild citrineos-core if relevant
if [[ "$1" == *"citrineos-core"* ]]; then
  echo "[nodemon] Rebuilding citrineos-core..."
  (cd ../../citrineos-core && npm run clean && npm run build)

  echo "[nodemon] Reinstalling citrineos-core into citrineos-ocpi..."
  (cd ../../citrineos-ocpi && npm i)
else
  echo "[nodemon] Change in local files — skipping core rebuild."
fi

# Rebuild & migrate current service
echo "[nodemon] Rebuilding local project..."
npm run build --prefix ../

echo "[nodemon] Running database migrations..."
npm run migrate --prefix ../

# Start the server — use exec so nodemon tracks it
echo "[nodemon] Starting Node server..."
exec node --inspect=0.0.0.0:9229 ./dist/index.js