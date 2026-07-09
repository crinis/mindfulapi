import { SetMetadata } from '@nestjs/common';

/** Metadata key marking a route as exempt from bearer-token authentication. */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route or controller as public — the {@link AuthTokenGuard} skips it.
 * Used for unauthenticated probes such as `/health`.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
