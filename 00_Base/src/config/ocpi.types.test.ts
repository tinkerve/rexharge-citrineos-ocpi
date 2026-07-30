// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { defineOcpiConfig } from './defineOcpiConfig';
import { OcpiConfig, OcpiConfigInput, ocpiConfigSchema } from './ocpi.types';

describe('OCPI request-log configuration', () => {
  it('accepts an older public config and returns a complete disabled config', () => {
    const legacyConfig: OcpiConfigInput = {
      env: 'development',
      ocpiServer: {
        host: '0.0.0.0',
        port: 8085,
      },
      ocpiModules: {},
      database: {
        host: 'localhost',
        port: 5432,
        database: 'ocpi',
        username: 'ocpi',
        password: 'ocpi',
      },
      cache: { memory: true },
      graphql: { endpoint: 'http://localhost:8090/v1/graphql' },
      commands: {
        timeout: 30,
        ocpiBaseUrl: 'http://localhost:8085/ocpi',
        ocpp1_6: {
          remoteStartTransactionRequestUrl: 'http://localhost/start-1.6',
          remoteStopTransactionRequestUrl: 'http://localhost/stop-1.6',
          unlockConnectorRequestUrl: 'http://localhost/unlock-1.6',
        },
        ocpp2_0_1: {
          requestStartTransactionRequestUrl: 'http://localhost/start-2.0.1',
          requestStopTransactionRequestUrl: 'http://localhost/stop-2.0.1',
          unlockConnectorRequestUrl: 'http://localhost/unlock-2.0.1',
        },
      },
      logLevel: 2,
      defaultPageLimit: 50,
      maxPageLimit: 1000,
    };

    const parsed: OcpiConfig = defineOcpiConfig(legacyConfig);

    expect(parsed.requestLog).toEqual({
      enabled: false,
      gatewayEndpoint: '',
      sharedSecret: '',
      timeoutMs: 2000,
    });
    expect(parsed.ocpiServer).toEqual({
      host: '0.0.0.0',
      port: 8085,
    });
  });

  it('requires an absolute endpoint and secret when enabled', () => {
    const schema = ocpiConfigSchema.shape.requestLog;

    expect(
      schema.safeParse({
        enabled: true,
        gatewayEndpoint: '',
        sharedSecret: '',
        timeoutMs: 2000,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        enabled: true,
        gatewayEndpoint:
          'https://gateway.test/api/internal/ocpi/cpo-request-logs',
        sharedSecret: 'configured-secret-with-32-characters',
        timeoutMs: 2000,
      }).success,
    ).toBe(true);
  });
});
