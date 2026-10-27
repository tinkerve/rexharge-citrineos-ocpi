// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import * as crypto from 'crypto';
import { KoaMiddlewareInterface } from 'routing-controllers';
import { HttpHeader, HttpStatus } from '@citrineos/base';
import { Inject, Service } from 'typedi';
import { OcpiConfig, OcpiConfigToken } from '../../config/ocpi.types';
import { ContentType } from '../ContentType';
import { HttpExceptionBody } from './HttpExceptionHandler';

const SCHEME = 'AccessKey ';

/**
 * Admits a caller to the partner-registration admin routes only when it
 * presents `Authorization: AccessKey <registration.adminApiKey>`.
 *
 * Fails closed: with no key configured, every caller is refused. The gateway
 * is the only intended caller; who in the product may register partners is
 * decided there, against its role system.
 */
@Service()
export class AdminKeyMiddleware implements KoaMiddlewareInterface {
  constructor(@Inject(OcpiConfigToken) private readonly config: OcpiConfig) {}

  async use(context: any, next: (err?: any) => Promise<any>): Promise<any> {
    const header =
      context.request?.headers?.[HttpHeader.Authorization.toLowerCase()];

    if (!isAdminKeyValid(header, this.config.registration?.adminApiKey)) {
      context.type = ContentType.JSON;
      context.status = HttpStatus.UNAUTHORIZED;
      context.body = JSON.stringify(new HttpExceptionBody('Not Authorized'));
      return;
    }

    return next();
  }
}

function isAdminKeyValid(header: unknown, configuredKey?: string): boolean {
  if (!configuredKey) return false;
  if (typeof header !== 'string' || !header.startsWith(SCHEME)) return false;

  // Hash both sides so the comparison runs on equal-length buffers and its
  // duration says nothing about the configured key's length.
  const presented = crypto
    .createHash('sha256')
    .update(header.slice(SCHEME.length))
    .digest();
  const expected = crypto.createHash('sha256').update(configuredKey).digest();
  return crypto.timingSafeEqual(presented, expected);
}
