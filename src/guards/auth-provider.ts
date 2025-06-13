import { APP_GUARD } from '@nestjs/core';
import { AuthTokenGuard } from './auth-token.guard';

export const authProvider = {
  provide: APP_GUARD,
  useClass: AuthTokenGuard,
};
