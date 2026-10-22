/** E2E tests: full Nest app over HTTP (Supertest). */
module.exports = {
  rootDir: '..',
  testRegex: 'test/e2e/.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/support/postgres-global-setup.ts',
  globalTeardown: '<rootDir>/test/support/postgres-global-teardown.ts',
  testTimeout: 60000,
  setupFiles: ['<rootDir>/test/e2e/setup-env.ts'],
};
