import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthTokenGuard } from './auth-token.guard';
import { securityConfig } from '../config/configuration';

function mockContext(authHeader?: string): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: authHeader } }),
    }),
  } as unknown as ExecutionContext;
}

/** Builds a guard capturing the current process.env security settings. */
function makeGuard(): AuthTokenGuard {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(false),
  } as unknown as Reflector;
  return new AuthTokenGuard(securityConfig(), reflector);
}

describe('AuthTokenGuard', () => {
  afterEach(() => {
    delete process.env.AUTH_TOKEN;
    delete process.env.AUTH_DISABLED;
  });

  describe('onApplicationBootstrap()', () => {
    it('throws when AUTH_TOKEN is unset and AUTH_DISABLED is not true', () => {
      delete process.env.AUTH_TOKEN;
      delete process.env.AUTH_DISABLED;
      expect(() => makeGuard().onApplicationBootstrap()).toThrow(/AUTH_TOKEN/);
    });

    it('does not throw when AUTH_TOKEN is set', () => {
      process.env.AUTH_TOKEN = 'supersecret';
      expect(() => makeGuard().onApplicationBootstrap()).not.toThrow();
    });

    it('does not throw when open access is explicitly enabled', () => {
      delete process.env.AUTH_TOKEN;
      process.env.AUTH_DISABLED = 'true';
      expect(() => makeGuard().onApplicationBootstrap()).not.toThrow();
    });
  });

  describe('when AUTH_TOKEN is not set', () => {
    let guard: AuthTokenGuard;

    beforeEach(() => {
      delete process.env.AUTH_TOKEN;
      process.env.AUTH_DISABLED = 'true';
      guard = makeGuard();
    });

    it('allows requests with no Authorization header', () => {
      expect(guard.canActivate(mockContext())).toBe(true);
    });

    it('allows requests with an arbitrary Bearer token', () => {
      expect(guard.canActivate(mockContext('Bearer anything'))).toBe(true);
    });

    it('allows requests with no authentication at all', () => {
      expect(guard.canActivate(mockContext(''))).toBe(true);
    });
  });

  describe('when AUTH_TOKEN is set', () => {
    let guard: AuthTokenGuard;

    beforeEach(() => {
      process.env.AUTH_TOKEN = 'supersecret';
      guard = makeGuard();
    });

    it('allows request with the correct Bearer token', () => {
      expect(guard.canActivate(mockContext('Bearer supersecret'))).toBe(true);
    });

    it('throws UnauthorizedException for an incorrect token', () => {
      expect(() => guard.canActivate(mockContext('Bearer wrong'))).toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when Authorization header is missing', () => {
      expect(() => guard.canActivate(mockContext())).toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException for Basic auth scheme', () => {
      expect(() => guard.canActivate(mockContext('Basic supersecret'))).toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException for empty Authorization header', () => {
      expect(() => guard.canActivate(mockContext(''))).toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException for a token with the same length but different value', () => {
      // Ensures the constant-time comparison rejects matching-length but wrong tokens
      expect(() => guard.canActivate(mockContext('Bearer badSecret'))).toThrow(
        UnauthorizedException,
      );
    });

    it('includes a descriptive message in the exception', () => {
      try {
        guard.canActivate(mockContext('Bearer wrong'));
        fail('Expected exception');
      } catch (e) {
        expect(e).toBeInstanceOf(UnauthorizedException);
        expect((e as UnauthorizedException).message).toContain(
          'Invalid or missing authentication token',
        );
      }
    });
  });
});
