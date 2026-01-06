// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Safely converts a Date or string to ISO 8601 format with Z timezone.
 * Normalizes all datetime values to use Z format (e.g., "2015-06-29T20:39:09Z")
 * instead of +00:00 format, ensuring OCPI 2.2.1 compliance.
 * This is essential because GraphQL responses may return timestamps as strings
 * in various formats (e.g., "2025-12-31T03:20:37.063+00:00") which need normalization.
 *
 * @param value - The value to convert (Date, string, null, or undefined)
 * @param required - If true, throws error or returns empty string on null/undefined
 * @returns ISO 8601 formatted string with Z timezone or undefined
 */
export function toISOStringIfNeeded(
  value: Date | string | null | undefined,
): string | undefined;
export function toISOStringIfNeeded(
  value: Date | string | null | undefined,
  required: true,
): string;
export function toISOStringIfNeeded(
  value: Date | string | null | undefined,
  required: boolean = false,
): string | undefined {
  if (!value) {
    return required ? '' : undefined;
  }

  // Normalize all inputs to Date then to ISO string with Z timezone
  // This ensures consistent format regardless of input type
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}
