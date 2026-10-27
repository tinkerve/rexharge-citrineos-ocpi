// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { getMetadataArgsStorage } from 'routing-controllers';
import { AsRegistrationAdminEndpoint } from './AsRegistrationAdminEndpoint';
import { AdminKeyMiddleware } from '../middleware/AdminKeyMiddleware';
import { HttpExceptionHandler } from '../middleware/HttpExceptionHandler';

// Focus: a route marked as a registration admin endpoint always runs the admin
// key check — there is no configuration under which it is skipped.
describe('AsRegistrationAdminEndpoint', () => {
  class Routes {
    @AsRegistrationAdminEndpoint()
    mint() {
      return undefined;
    }
  }

  const middlewaresOn = (method: string) =>
    getMetadataArgsStorage()
      .uses.filter((use) => use.target === Routes && use.method === method)
      .map((use) => use.middleware);

  it('puts the admin key check in front of the route', () => {
    expect(middlewaresOn('mint')).toContain(AdminKeyMiddleware);
  });

  it('keeps the HTTP exception handling admin routes already had', () => {
    expect(middlewaresOn('mint')).toContain(HttpExceptionHandler);
  });
});
