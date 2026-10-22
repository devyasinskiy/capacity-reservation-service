import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { ScopesGuard } from './scopes.guard';

/**
 * APP_GUARD registers guards globally *through DI* (unlike app.useGlobalGuards), so they can
 * inject Reflector/config and also apply inside Test.createTestingModule. Secure by default:
 * routes opt out with @Public(), never opt in. Order matters: authenticate, then authorize.
 */
@Module({
  imports: [PassportModule],
  providers: [
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ScopesGuard },
  ],
})
export class AuthModule {}
