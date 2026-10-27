// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { UseBefore } from 'routing-controllers';
import { AdminKeyMiddleware } from '../middleware/AdminKeyMiddleware';
import { HttpExceptionHandler } from '../middleware/HttpExceptionHandler';

/**
 * Marks a partner-registration admin route: only a caller holding the
 * configured admin key gets through, and with no key configured nobody does.
 *
 * Deliberately separate from {@link AsAdminEndpoint}. That decorator falls
 * through when no OIDC config is present, and it also guards
 * `/tokens/realTimeAuth`, which citrine core calls without credentials — so
 * hardening it would break roaming authorization.
 */
export const AsRegistrationAdminEndpoint = function () {
  return function (object: any, methodName: string) {
    UseBefore(AdminKeyMiddleware)(object, methodName);
    UseBefore(HttpExceptionHandler)(object, methodName);
  };
};
