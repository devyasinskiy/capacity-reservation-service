// ConfigModule.forRoot validates env when AppModule is imported, so test env must exist first.
// DATABASE_URL comes from the Testcontainers globalSetup.
process.env.KAFKA_BROKERS ??= 'localhost:19092';
process.env.LOG_LEVEL ??= 'silent';
// HTTP e2e suites do not need the treasury consumer (Kafka is covered by integration tests).
process.env.KAFKA_CONSUMER_ENABLED ??= 'false';
