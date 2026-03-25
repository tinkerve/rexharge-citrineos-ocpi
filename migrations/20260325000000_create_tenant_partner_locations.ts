// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

'use strict';

import { DataTypes, QueryInterface, Sequelize } from 'sequelize';

export = {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.createTable('TenantPartnerLocations', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      tenantPartnerId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'TenantPartners',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      locationId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'Locations',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addConstraint('TenantPartnerLocations', {
      fields: ['tenantPartnerId', 'locationId'],
      type: 'unique',
      name: 'TenantPartnerLocations_tenantPartnerId_locationId_key',
    });

    await queryInterface.addIndex(
      'TenantPartnerLocations',
      ['tenantPartnerId'],
      {
        name: 'TenantPartnerLocations_tenantPartnerId_index',
      },
    );

    await queryInterface.addIndex('TenantPartnerLocations', ['locationId'], {
      name: 'TenantPartnerLocations_locationId_index',
    });
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.dropTable('TenantPartnerLocations');
  },
};
