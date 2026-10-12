// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import 'dotenv/config';
import { runBackfillCli } from './00_Base/src/scripts/cdrBackfillCli';

runBackfillCli(process.argv.slice(2), process.env)
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
