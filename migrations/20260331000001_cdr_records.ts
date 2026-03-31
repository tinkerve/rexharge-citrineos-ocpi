// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { DataTypes, QueryInterface } from 'sequelize';

export = {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.createTable('CdrRecords', {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      // The OCPI CDR id string (e.g. "CDR**REX**00001") – unique per CPO
      cdrId: {
        type: DataTypes.STRING(39),
        allowNull: false,
        unique: true,
      },
      // FK to citrine Transactions.id – links back to the OCPP transaction; one CDR per transaction
      transactionId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        unique: true,
        references: { model: 'Transactions', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      // FK to TenantPartners.id – the EMSP that received this CDR
      tenantPartnerId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'TenantPartners', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      // OCPI session id string (matches Session.id / CDR.session_id sent to the EMSP)
      ocpiSessionId: {
        type: DataTypes.STRING(36),
        allowNull: true,
      },
      startDateTime: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      endDateTime: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
      },
      // kWh consumed
      totalEnergy: {
        type: DataTypes.DECIMAL(10, 4),
        allowNull: false,
        defaultValue: 0,
      },
      // Session duration in hours (start → end)
      totalTime: {
        type: DataTypes.DECIMAL(10, 4),
        allowNull: false,
        defaultValue: 0,
      },
      // Idle / parking time in hours (connected but not charging)
      totalParkingTime: {
        type: DataTypes.DECIMAL(10, 4),
        allowNull: false,
        defaultValue: 0,
      },
      totalCostExclVat: {
        type: DataTypes.DECIMAL(12, 4),
        allowNull: false,
        defaultValue: 0,
      },
      totalCostInclVat: {
        type: DataTypes.DECIMAL(12, 4),
        allowNull: true,
      },
      totalEnergyCostExclVat: {
        type: DataTypes.DECIMAL(12, 4),
        allowNull: true,
      },
      totalTimeCostExclVat: {
        type: DataTypes.DECIMAL(12, 4),
        allowNull: true,
      },
      totalParkingCostExclVat: {
        type: DataTypes.DECIMAL(12, 4),
        allowNull: true,
      },
      totalFixedCostExclVat: {
        type: DataTypes.DECIMAL(12, 4),
        allowNull: true,
      },
      totalReservationCostExclVat: {
        type: DataTypes.DECIMAL(12, 4),
        allowNull: true,
      },
      taxRate: {
        type: DataTypes.DECIMAL(6, 4),
        allowNull: true,
      },
      // Full CDR JSON as sent to the EMSP – audit trail
      cdrData: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
    });

    await queryInterface.addIndex('CdrRecords', ['transactionId']);
    await queryInterface.addIndex('CdrRecords', ['tenantPartnerId']);
    await queryInterface.addIndex('CdrRecords', ['startDateTime']);
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.dropTable('CdrRecords');
  },
};
