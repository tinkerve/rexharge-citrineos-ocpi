// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

/** @type {import('ts-jest').JestConfigWithTsJest} */
/* eslint-disable */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // The workspace symlink resolves @citrineos/ocpi-base to its unbuilt
  // `dist`; module tests run against its sources instead.
  moduleNameMapper: {
    '^@citrineos/ocpi-base$': '<rootDir>/00_Base/src',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          baseUrl: '.',
          paths: { '@citrineos/ocpi-base': ['00_Base/src'] },
        },
      },
    ],
  },
};
