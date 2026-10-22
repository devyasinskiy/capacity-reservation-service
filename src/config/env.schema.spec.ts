import { validateEnv } from './env.schema';

const base = {
  DATABASE_URL: 'postgres://app:app@localhost:5432/capacity',
  KAFKA_BROKERS: 'localhost:19092, other:9092',
};

describe('validateEnv', () => {
  it('applies defaults and parses broker list', () => {
    const env = validateEnv(base);
    expect(env.HTTP_PORT).toBe(3000);
    expect(env.MANAGEMENT_PORT).toBe(9464);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_PRETTY).toBe(false);
    expect(env.KAFKA_BROKERS).toEqual(['localhost:19092', 'other:9092']);
  });

  it('coerces numeric ports from strings', () => {
    expect(validateEnv({ ...base, HTTP_PORT: '8080' }).HTTP_PORT).toBe(8080);
  });

  it('fails fast with a readable message on invalid config', () => {
    expect(() => validateEnv({ ...base, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ KAFKA_BROKERS: 'a:1' })).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ ...base, HTTP_PORT: '70000' })).toThrow(/HTTP_PORT/);
  });
});
