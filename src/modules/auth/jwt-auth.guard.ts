import { type ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ErrorCode } from '../../shared/errors/error-codes';
import { IS_PUBLIC_KEY } from './decorators';
import type { Principal } from './principal';

/** Authentication: every route requires a valid JWT unless explicitly marked @Public(). */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(private readonly reflector: Reflector) {
    super();
  }

  /** Skips authentication for `@Public()` routes; otherwise runs the Passport JWT strategy. */
  override canActivate(ctx: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    return isPublic ? true : super.canActivate(ctx);
  }

  /** Maps every auth failure to a generic 401 `UNAUTHENTICATED`; the reason is only logged. */
  override handleRequest<T = Principal>(err: unknown, user: T | false, info: unknown): T {
    if (err || !user) {
      // The reason (expired, bad signature, wrong audience…) is logged, never returned to the client.
      const reason =
        info instanceof Error ? info.message : err instanceof Error ? err.message : 'no user';
      this.logger.debug({ reason }, 'Authentication failed');
      throw new UnauthorizedException({ code: ErrorCode.UNAUTHENTICATED });
    }
    return user;
  }
}
