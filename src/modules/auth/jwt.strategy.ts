import { readFileSync } from 'node:fs';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Env } from '../../config/env.schema';
import { ErrorCode } from '../../shared/errors/error-codes';
import { assertVerificationKeyAllowed } from './dev-key';
import { type Principal, principalFromClaims } from './principal';

/**
 * Passport strategy (Nest wraps Passport strategies as injectable providers so they get config
 * via DI). RS256 only — pinning the algorithm prevents alg-confusion (e.g. HS256 signed with the
 * public key) and `none` tokens. See ADR-007.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService<Env, true>) {
    const publicKey = readFileSync(config.get('JWT_PUBLIC_KEY_PATH', { infer: true }), 'utf8');
    assertVerificationKeyAllowed(publicKey, config.get('NODE_ENV', { infer: true }));
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: publicKey,
      algorithms: ['RS256'],
      issuer: config.get('JWT_ISSUER', { infer: true }),
      audience: config.get('JWT_AUDIENCE', { infer: true }),
      ignoreExpiration: false,
      jsonWebTokenOptions: {
        clockTolerance: config.get('JWT_CLOCK_TOLERANCE_SECONDS', { infer: true }),
      },
    });
  }

  /**
   * Called by Passport after signature/iss/aud/exp checks; maps claims to a {@link Principal}.
   * @throws UnauthorizedException if required claims (`sub`, `tid`) are missing or malformed.
   */
  validate(payload: unknown): Principal {
    const principal = principalFromClaims(payload);
    if (!principal) throw new UnauthorizedException({ code: ErrorCode.UNAUTHENTICATED });
    return principal;
  }
}
