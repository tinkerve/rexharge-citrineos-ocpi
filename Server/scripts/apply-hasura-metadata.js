#!/usr/bin/env node
/**
 * apply-hasura-metadata.js
 *
 * Reads Server/data/hasura/metadata.json and applies it to the Hasura instance
 * via the replace_metadata REST API.  Called during container startup AFTER
 * database migrations so Hasura can track the latest table/relationship config.
 *
 * Environment variables:
 *   HASURA_GRAPHQL_ENDPOINT      e.g. http://graphql-engine:8080 (default http://localhost:8090)
 *   HASURA_GRAPHQL_ADMIN_SECRET  required — matches the swarm compose var
 *   HASURA_APPLY_SKIP            set to "true" to skip this step entirely
 *   HASURA_APPLY_RETRIES         number of connect retries before giving up (default 10)
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const SKIP = process.env.HASURA_APPLY_SKIP === 'true';
const HASURA_URL = process.env.HASURA_GRAPHQL_ENDPOINT || 'http://localhost:8090';
const ADMIN_SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
if (!ADMIN_SECRET) {
  console.error(
    '[apply-hasura-metadata] HASURA_GRAPHQL_ADMIN_SECRET env var is not set.',
  );
  process.exit(1);
}
const MAX_RETRIES = parseInt(process.env.HASURA_APPLY_RETRIES || '10', 10);
const RETRY_DELAY_MS = 3000;

const METADATA_PATH = path.join(
  __dirname,
  '..',
  'data',
  'hasura',
  'metadata.json',
);

if (SKIP) {
  console.log('[apply-hasura-metadata] HASURA_APPLY_SKIP=true – skipping.');
  process.exit(0);
}

if (!fs.existsSync(METADATA_PATH)) {
  console.error(
    '[apply-hasura-metadata] metadata file not found at',
    METADATA_PATH,
  );
  process.exit(1);
}

const stored = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));
// The export response wraps in { resource_version, metadata: {...} }; we need just the inner object.
const metadata = stored.metadata ?? stored;

function request(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-hasura-admin-secret': ADMIN_SECRET,
      },
    };
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyMetadata(attempt = 1) {
  try {
    console.log(
      `[apply-hasura-metadata] Sending replace_metadata to ${HASURA_URL} (attempt ${attempt}/${MAX_RETRIES})...`,
    );
    const { status, body } = await request(`${HASURA_URL}/v1/metadata`, {
      type: 'replace_metadata',
      version: 2,
      args: {
        metadata,
        allow_inconsistent_metadata: false,
      },
    });

    if (status === 200) {
      console.log('[apply-hasura-metadata] Metadata applied successfully.');
      process.exit(0);
    }

    // Hasura returns 400 for inconsistent metadata – surface the error properly
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = { error: body };
    }
    const msg = parsed.error || parsed.message || JSON.stringify(parsed);

    if (status === 400 && msg.includes('inconsistent')) {
      console.warn(
        '[apply-hasura-metadata] WARNING: metadata has inconsistencies:',
        msg,
      );
      console.warn(
        '[apply-hasura-metadata] Retrying with allow_inconsistent_metadata=true...',
      );
      const retry = await request(`${HASURA_URL}/v1/metadata`, {
        type: 'replace_metadata',
        version: 2,
        args: { metadata, allow_inconsistent_metadata: true },
      });
      if (retry.status === 200) {
        console.log(
          '[apply-hasura-metadata] Applied with inconsistencies allowed. Check Hasura console.',
        );
        process.exit(0);
      }
      console.error(
        '[apply-hasura-metadata] Still failed after retry:',
        retry.body,
      );
      process.exit(1);
    }

    console.error(`[apply-hasura-metadata] Unexpected status ${status}:`, msg);
    process.exit(1);
  } catch (err) {
    // Connection refused / not ready yet
    if (attempt < MAX_RETRIES) {
      console.log(
        `[apply-hasura-metadata] Hasura not ready (${err.message}), retrying in ${RETRY_DELAY_MS / 1000}s...`,
      );
      await sleep(RETRY_DELAY_MS);
      return applyMetadata(attempt + 1);
    }
    console.error(
      '[apply-hasura-metadata] Could not connect to Hasura after',
      MAX_RETRIES,
      'attempts:',
      err.message,
    );
    process.exit(1);
  }
}

applyMetadata();
