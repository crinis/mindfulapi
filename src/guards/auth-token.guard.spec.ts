import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthTokenGuard } from './auth-token.guard';

function mockContext(authHeader?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: authHeader } }),
    }),
  } as ExecutionContext;
}

describe('AuthTokenGuard', () => {
  let guard: AuthTokenGuard;

  beforeEach(() => {
    guard = new AuthTokenGuard();
  });

  afterEach(() => {
    delete process.env.AUTH_TOKEN;
  });

  describe('when AUTH_TOKEN is not set', () => {
    beforeEach(() => {
      delete process.env.AUTH_TOKEN;
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
    beforeEach(() => {
      process.env.AUTH_TOKEN = 'supersecret';
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
