import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class AuthTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const token = process.env.AUTH_TOKEN;
    if (!token) {
      // No token set, allow all requests
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== token) {
      throw new UnauthorizedException('Invalid or missing authentication token');
    }
    return true;
  }
}
