/** Integration tests: real Postgres / Kafka via Testcontainers. Run serially. */
module.exports = {
  rootDir: '..',
  testRegex: 'test/integration/.*\\.int-spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/support/postgres-global-setup.ts',
  globalTeardown: '<rootDir>/test/support/postgres-global-teardown.ts',
  testTimeout: 180000,
  maxWorkers: 1,
  passWithNoTests: true,
};
