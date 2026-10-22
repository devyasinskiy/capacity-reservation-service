import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ErrorCode } from '../../shared/errors/error-codes';
import { IS_PUBLIC_KEY, REQUIRED_SCOPES_KEY } from './decorators';
import type { Principal } from './principal';

/**
 * Authorization: runs after JwtAuthGuard (global guards execute in registration order).
 * Fail-closed: a non-public route that forgot @RequireScopes is denied, not silently allowed.
 */
@Injectable()
export class ScopesGuard implements CanActivate {
  private readonly logger = new Logger(ScopesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  /**
   * Allows the request only if the principal holds every scope declared on the route.
   * @throws ForbiddenException `INSUFFICIENT_SCOPE` if a scope is missing or none are declared.
   */
  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRED_SCOPES_KEY,
      targets,
    );
    if (!required || required.length === 0) {
      this.logger.error(
        { handler: `${ctx.getClass().name}.${ctx.getHandler().name}` },
        'Route has no @RequireScopes; denying (fail-closed)',
      );
      throw new ForbiddenException({ code: ErrorCode.INSUFFICIENT_SCOPE });
    }

    const { user } = ctx.switchToHttp().getRequest<Request & { user: Principal }>();
    if (!required.every((scope) => user.scopes.has(scope))) {
      throw new ForbiddenException({ code: ErrorCode.INSUFFICIENT_SCOPE });
    }
    return true;
  }
}
