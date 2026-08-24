// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ILogObj, Logger } from 'tslog';
import { KoaMiddlewareInterface, Middleware } from 'routing-controllers';
import { Inject, Service } from 'typedi';
import { OcpiRequestLogClient } from '../../services/OcpiRequestLogClient';
import { OcpiRequestLogPayload } from '../../types/ocpi-request-log.types';
import { OcpiHttpHeader } from '../OcpiHttpHeader';

const VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?$/;
const LOGGABLE_MODULES = new Set([
  'credentials',
  'locations',
  'sessions',
  'cdrs',
  'tariffs',
  'tokens',
  'commands',
  'chargingprofiles',
]);

function isLoggableOcpiRequest(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const segments = new URL(url, 'http://internal.invalid').pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => segment.toLowerCase());
    if (segments[0] !== 'ocpi') return false;
    if (segments[1] === 'versions') return segments.length >= 2;
    return (
      VERSION_PATTERN.test(segments[1] ?? '') &&
      LOGGABLE_MODULES.has(segments[2])
    );
  } catch {
    return false;
  }
}

function normalizeThrownError(error: unknown): {
  name: string;
  message: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  let name = 'NonErrorThrown';
  let message: string | undefined;
  if (error && typeof error === 'object') {
    try {
      const errorLike = error as {
        name?: unknown;
        message?: unknown;
      };
      const candidateName = errorLike.name;
      if (typeof candidateName === 'string') {
        name = candidateName;
      }
      const candidateMessage = errorLike.message;
      if (typeof candidateMessage === 'string') {
        message = candidateMessage;
      }
    } catch {
      // Fall back below when an error-like object has throwing accessors.
    }
  }
  if (message === undefined) {
    try {
      message = String(error);
    } catch {
      message = 'Unknown non-Error thrown value';
    }
  }
  return { name, message };
}

@Service()
@Middleware({ type: 'before', priority: 100 })
export class OcpiRequestLogMiddleware implements KoaMiddlewareInterface {
  constructor(
    private readonly requestLogClient: OcpiRequestLogClient,
    @Inject() private readonly logger: Logger<ILogObj>,
  ) {}

  async use(context: any, next: (err?: any) => Promise<any>): Promise<any> {
    if (!this.requestLogClient.enabled) return next();
    const requestUrl =
      context.request?.originalUrl ?? context.request?.url ?? context.url;
    if (!isLoggableOcpiRequest(requestUrl)) return next();

    const requestMethod = context.request?.method ?? context.method;
    const requestHeaders = { ...(context.request?.headers ?? {}) };
    let requestBody = context.request?.body;
    try {
      requestBody = structuredClone(requestBody);
    } catch {
      // Request bodies are normally JSON. Retain the original value if custom
      // middleware supplied a non-cloneable body.
    }
    const startedAt = Date.now();
    let caughtError: unknown;
    let hasCaughtError = false;

    try {
      return await next();
    } catch (error) {
      hasCaughtError = true;
      caughtError = error;
      throw error;
    } finally {
      try {
        const tenantPartner = context.state?.tenantPartner;
        const payload: OcpiRequestLogPayload = {
          direction: 'INCOMING',
          request: {
            method: requestMethod,
            url: requestUrl,
            headers: requestHeaders,
            body: requestBody,
          },
          response: {
            status: context.status,
            headers: context.response?.headers,
            body: context.body,
          },
          durationMs: Date.now() - startedAt,
          partner: tenantPartner
            ? {
                tenantPartnerId: tenantPartner.id,
                countryCode: tenantPartner.countryCode,
                partyId: tenantPartner.partyId,
              }
            : undefined,
          locationId: context.params?.location_id ?? context.params?.locationId,
          requestId: requestHeaders[OcpiHttpHeader.XRequestId.toLowerCase()],
          correlationId:
            requestHeaders[OcpiHttpHeader.XCorrelationId.toLowerCase()],
          error: hasCaughtError ? normalizeThrownError(caughtError) : undefined,
        };

        void this.requestLogClient.send(payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to build OCPI request log: ${message}`);
      }
    }
  }
}
