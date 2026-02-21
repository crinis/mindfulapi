import { APP_GUARD } from '@nestjs/core';
import { AuthTokenGuard } from './auth-token.guard';

/**
 * Registers the global bearer-token authentication guard for all routes.
 */
export const authProvider = {
  provide: APP_GUARD,
  useClass: AuthTokenGuard,
};
