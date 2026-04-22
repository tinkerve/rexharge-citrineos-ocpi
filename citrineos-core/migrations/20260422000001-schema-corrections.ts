// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0
'use strict';

/** @type {import('sequelize-cli').Migration} */
import { QueryInterface } from 'sequelize';

export = {
  up: async (queryInterface: QueryInterface) => {
    const constraintExists = async (
      tableName: string,
      constraintName: string,
    ): Promise<boolean> => {
      const [results] = await queryInterface.sequelize.query(
        `SELECT constraint_name FROM information_schema.table_constraints
         WHERE table_schema = 'public' AND table_name = $1 AND constraint_name = $2;`,
        { bind: [tableName, constraintName] },
      );
      return results.length > 0;
    };

    // 1. Drop the stationId unique constraint from Tariffs (stationId is not the upsert key — connectorId is)
    if (await constraintExists('Tariffs', 'Tariffs_stationId_key')) {
      await queryInterface.sequelize.query(
        'ALTER TABLE "Tariffs" DROP CONSTRAINT "Tariffs_stationId_key";',
      );
    }

    // 2. Add unique constraint on Tariffs.connectorId (used as the upsert conflict key in the gateway)
    if (!(await constraintExists('Tariffs', 'Tariffs_connectorId'))) {
      await queryInterface.sequelize.query(
        'ALTER TABLE "Tariffs" ADD CONSTRAINT "Tariffs_connectorId" UNIQUE ("connectorId");',
      );
    }

    // 3. Allow NULL on Authorizations.realTimeAuth (was added as NOT NULL in 20250618150800, but should be optional)
    await queryInterface.sequelize.query(
      'ALTER TABLE "Authorizations" ALTER COLUMN "realTimeAuth" DROP NOT NULL;',
    );
  },

  down: async (queryInterface: QueryInterface) => {
    // Reverse: restore stationId unique
    await queryInterface.sequelize.query(
      'ALTER TABLE "Tariffs" ADD CONSTRAINT "Tariffs_stationId_key" UNIQUE ("stationId");',
    );

    // Reverse: drop connectorId unique
    await queryInterface.sequelize.query(
      'ALTER TABLE "Tariffs" DROP CONSTRAINT IF EXISTS "Tariffs_connectorId";',
    );

    // Reverse: restore NOT NULL on realTimeAuth
    await queryInterface.sequelize.query(
      `UPDATE "Authorizations" SET "realTimeAuth" = 'Never' WHERE "realTimeAuth" IS NULL;`,
    );
    await queryInterface.sequelize.query(
      'ALTER TABLE "Authorizations" ALTER COLUMN "realTimeAuth" SET NOT NULL;',
    );
  },
};
