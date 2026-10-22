# DEV-ONLY JWT keypair — never use outside local development

This RSA keypair exists so `docker compose up` and the test suite work with no external identity
provider. It is committed on purpose (see ADR-007) and **is not a secret**.

- `private.pem` — signs tokens via `npm run token`
- `public.pem` — verified by the API (`JWT_PUBLIC_KEY_PATH`)

The service refuses to start with this public key when `NODE_ENV=production`
(fingerprint check in `src/modules/auth/dev-key.ts`). It is not baked into the Docker image;
docker-compose mounts it read-only.
