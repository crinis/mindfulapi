/**
 * Supported language codes for accessibility rule information.
 * These correspond to the locales supported by Kayle's importRules function.
 */
export type Language = 
  | 'ar'      // Arabic
  | 'fr'      // French  
  | 'es'      // Spanish
  | 'it'      // Italian
  | 'ja'      // Japanese
  | 'nl'      // Dutch
  | 'pl'      // Polish
  | 'ko'      // Korean
  | 'zh_CN'   // Chinese (Simplified)
  | 'zh_TW'   // Chinese (Traditional)
  | 'da'      // Danish
  | 'de'      // German
  | 'eu'      // Basque
  | 'he'      // Hebrew
  | 'no_NB'   // Norwegian (Bokmål)
  | 'pt_BR'   // Portuguese (Brazil)
  | 'en';     // English

/**
 * Default language when none is specified
 */
export const DEFAULT_LANGUAGE: Language = 'en';
