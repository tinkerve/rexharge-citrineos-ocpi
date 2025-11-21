// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { BadRequestError, createParamDecorator } from 'routing-controllers';
import { HttpHeader } from '@citrineos/base';
import { base64Decode } from '../Util';

const tokenPrefix = 'Token ';

/**
 * Extracts and attempts to decode the token from the Authorization header.
 * Supports both Base64-encoded tokens (OCPI 2.2-d2+) and plain tokens (OCPI 2.1.1/2.2).
 *
 * @param authorization - The Authorization header value
 * @param tryBothEncodings - If true, returns an array with both decoded and raw token for database lookup
 * @returns The extracted token(s)
 */
export function extractToken(
  authorization: string,
  tryBothEncodings = false,
): string | string[] {
  let token = authorization;
  if (token.startsWith(tokenPrefix)) {
    token = authorization.slice(tokenPrefix.length).trim();

    if (tryBothEncodings) {
      // Return both decoded and raw token for database lookup
      try {
        const decoded = base64Decode(token);
        // Return both: decoded first (OCPI 2.2-d2+), then raw (OCPI 2.1.1/2.2)
        return decoded !== token ? [decoded, token] : [token];
      } catch (_error) {
        // If decoding fails, just return the raw token
        return [token];
      }
    }

    // Single token mode: try Base64 decoding, fall back to raw token
    try {
      const decoded = base64Decode(token);
      if (decoded && decoded !== token && decoded.length > 0) {
        return decoded;
      }
    } catch (_error) {
      // If decoding fails, fall through to use raw token
    }

    return token;
  } else {
    throw new BadRequestError('Invalid Authorization header format');
  }
}

/**
 * AuthToken convenience decorator will extract the token from the Authorization header. Allows to easilly access auth
 * token in request handler like so:
 *
 * @Get()
 * some(@AuthToken() token: string) {
 *   console.log(token);
 * }
 */
export function AuthToken() {
  return createParamDecorator({
    required: true,
    value: (action) => {
      const authorizationHeader =
        action.request.headers[HttpHeader.Authorization.toLowerCase()];
      if (authorizationHeader) {
        return extractToken(authorizationHeader);
      } else {
        // todo handle non-existent or improperly formatted Authorization header which should be captured in auth middleware and should theoretically be correct by the time this runs
        return undefined;
      }
    },
  });
}
