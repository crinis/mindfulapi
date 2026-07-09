import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Inject,
  Logger,
  OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { securityConfig } from '../config/configuration';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Global guard enforcing a static bearer token when `AUTH_TOKEN` is configured.
 *
 * Running without authentication requires an explicit opt-in via
 * `AUTH_DISABLED=true`; an unset `AUTH_TOKEN` alone aborts startup so the
 * API can never be exposed openly by accident.
 */
@Injectable()
export class AuthTokenGuard implements CanActivate, OnApplicationBootstrap {
  private readonly logger = new Logger(AuthTokenGuard.name);

  /**
   * @param security Security namespace configuration (token, opt-out flag).
   */
  constructor(
    @Inject(securityConfig.KEY)
    private readonly security: ConfigType<typeof securityConfig>,
    private readonly reflector: Reflector,
  ) {}

  /**
   * Fails fast at startup when no token is configured and open access was
   * not explicitly requested.
   */
  onApplicationBootstrap(): void {
    if (this.security.authToken) {
      return;
    }
    if (!this.security.authDisabled) {
      throw new Error(
        'AUTH_TOKEN is not set. Configure AUTH_TOKEN, or set AUTH_DISABLED=true to explicitly run the API without authentication.',
      );
    }
    this.logger.warn(
      'Authentication is DISABLED (AUTH_DISABLED=true). The API accepts unauthenticated requests — do not expose it publicly.',
    );
  }

  /**
   * Authorizes the incoming request based on `Authorization: Bearer <token>`.
   *
   * Both sides are hashed before the constant-time comparison so neither
   * timing nor a length pre-check leaks information about the token.
   *
   * @param context Nest execution context.
   * @returns `true` when request is authorized.
   * @throws UnauthorizedException When the expected bearer token is missing or invalid.
   */
  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const token = this.security.authToken;
    if (!token) {
      // Validated at bootstrap: only reachable with AUTH_DISABLED=true.
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers['authorization'];
    const provided = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;

    if (!provided || !this.matchesToken(provided, token)) {
      throw new UnauthorizedException(
        'Invalid or missing authentication token',
      );
    }
    return true;
  }

  /**
   * Constant-time equality on SHA-256 digests of both values.
   */
  private matchesToken(provided: string, expected: string): boolean {
    const providedHash = createHash('sha256').update(provided).digest();
    const expectedHash = createHash('sha256').update(expected).digest();
    return timingSafeEqual(providedHash, expectedHash);
  }
}
