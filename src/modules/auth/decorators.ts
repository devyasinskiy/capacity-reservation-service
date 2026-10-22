import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Principal } from './principal';
import type { Scope } from './scopes';

/** Route metadata key set by {@link Public}. */
export const IS_PUBLIC_KEY = 'auth:isPublic';
/** Route metadata key set by {@link RequireScopes}. */
export const REQUIRED_SCOPES_KEY = 'auth:requiredScopes';

/**
 * Opt a route out of authentication. Only for infrastructure; no business route uses it.
 * (Decorators + SetMetadata + Reflector is how Nest attaches per-route policy read by guards.)
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** All listed scopes are required (AND). Every non-public route must declare scopes. */
export const RequireScopes = (...scopes: [Scope, ...Scope[]]) =>
  SetMetadata(REQUIRED_SCOPES_KEY, scopes);

/** Injects the verified caller into a handler parameter. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal =>
    ctx.switchToHttp().getRequest<Request & { user: Principal }>().user,
);
