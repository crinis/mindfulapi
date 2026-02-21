/**
 * How a scan run should select pages to analyze.
 */
export enum ScanMode {
  /**
   * Analyze exactly one URL.
   */
  SINGLE_URL = 'single_url',

  /**
   * Analyze an explicit list of URLs.
   */
  URL_LIST = 'url_list',

  /**
   * Crawl from one or more seed URLs and analyze discovered pages.
   */
  CRAWL = 'crawl',
}
