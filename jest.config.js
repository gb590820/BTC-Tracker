/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/__tests__/**/*.test.tsx',
    '**/tests/**/*.test.ts',
    '**/tests/**/*.test.tsx'
  ],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    // @scure/* and @noble/* ship ESM only. Jest runs this project in CJS mode,
    // so those packages have to be downlevelled to CommonJS on the way in.
    // The pattern is anchored on node_modules to avoid touching our own .js
    // files (src/tests/setup.js, src/tests/jest.env.js).
    '^.+/node_modules/(@scure|@noble)/.+\\.m?js$': [
      'ts-jest',
      {
        tsconfig: {
          allowJs: true,
          module: 'commonjs',
          target: 'es2020',
          esModuleInterop: true,
        },
      },
    ],
  },
  // Everything in node_modules stays untransformed except the two ESM-only
  // crypto libraries above.
  transformIgnorePatterns: ['/node_modules/(?!@scure|@noble)'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/scripts/**/*',
    '!src/app/**/layout.tsx',
    '!src/app/**/page.tsx',
    '!src/components/**/*',
    '!src/app/**/*.tsx'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/src/tests/setup.ts'],
  testTimeout: 10000,
  // All test files share the same SQLite test database — run serially to
  // prevent concurrent cleanTestDatabase() calls from causing FK violations.
  maxWorkers: 1,
  clearMocks: true,
  restoreMocks: true,
  setupFiles: ['<rootDir>/src/tests/jest.env.js']
}; 