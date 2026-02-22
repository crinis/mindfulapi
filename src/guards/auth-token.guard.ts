import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';

/**
 * Global guard enforcing a static bearer token when `AUTH_TOKEN` is configured.
 */
@Injectable()
export class AuthTokenGuard implements CanActivate {
  /**
   * Authorizes the incoming request based on `Authorization: Bearer <token>`.
   *
   * Uses a constant-time comparison to prevent timing-based token enumeration.
   *
   * @param context Nest execution context.
   * @returns `true` when request is authorized.
   * @throws UnauthorizedException When the expected bearer token is missing or invalid.
   */
  canActivate(context: ExecutionContext): boolean {
    const token = process.env.AUTH_TOKEN;
    if (!token) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers['authorization'];
    const provided =
      authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (
      !provided ||
      provided.length !== token.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(token))
    ) {
      throw new UnauthorizedException(
        'Invalid or missing authentication token',
      );
    }
    return true;
  }
}
