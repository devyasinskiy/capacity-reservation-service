/** Unit tests: co-located *.spec.ts under src/. No I/O. */
module.exports = {
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testEnvironment: 'node',
  coverageDirectory: '../coverage',
  collectCoverageFrom: ['**/*.ts', '!main.ts', '!**/*.module.ts'],
};
