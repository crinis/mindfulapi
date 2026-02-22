/**
 * Shared class-validator options for absolute HTTP(S) URLs.
 */
export const HTTP_URL_VALIDATION_OPTIONS = {
  require_tld: false,
  require_protocol: true,
  protocols: ['http', 'https'],
};
