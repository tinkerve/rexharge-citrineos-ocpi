// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

/**
 * A registration exchange with a partner that did not complete. Its message
 * has been through redactError and is safe to log, return, store and show.
 */
export class RegistrationHandshakeException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationHandshakeException';
  }
}
