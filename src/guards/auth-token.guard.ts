import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * Global guard enforcing a static bearer token when `AUTH_TOKEN` is configured.
 */
@Injectable()
export class AuthTokenGuard implements CanActivate {
  /**
   * Authorizes the incoming request based on `Authorization: Bearer <token>`.
   *
   * @param context Nest execution context.
   * @returns `true` when request is authorized.
   * @throws UnauthorizedException When the expected bearer token is missing or invalid.
   */
  canActivate(context: ExecutionContext): boolean {
    const token = process.env.AUTH_TOKEN;
    if (!token) {
      // No token set, allow all requests
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers['authorization'];
    if (
      !authHeader ||
      !authHeader.startsWith('Bearer ') ||
      authHeader.split(' ')[1] !== token
    ) {
      throw new UnauthorizedException(
        'Invalid or missing authentication token',
      );
    }
    return true;
  }
}
