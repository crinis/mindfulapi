/**
 * Enumeration of accessibility scan processing states throughout the lifecycle.
 *
 * This enum tracks the progression of accessibility scans from creation through
 * completion, enabling real-time status monitoring and result availability
 * indication for API consumers.
 *
 * The status progression follows a predictable flow:
 * PENDING → RUNNING → [ANALYZING] → (COMPLETED | FAILED). The ANALYZING phase
 * occurs only when the optional LLM-agent audit is requested and enabled.
 */
export enum ScanStatus {
  /**
   * Scan has been created and queued for processing.
   *
   * The scan is waiting in the job queue to be picked up by a background
   * worker. No accessibility analysis has begun yet.
   */
  PENDING = 'pending',

  /**
   * Scan is currently running deterministic (axe-core) analysis.
   *
   * Browser automation is active, pages are being loaded, and accessibility
   * issues are being identified and documented.
   */
  RUNNING = 'running',

  /**
   * Deterministic analysis is complete and the optional LLM-agent audit is
   * running.
   *
   * Only reached when the scan requested AI audit skills and the feature is
   * enabled server-side. Axe-core results are already persisted; agent
   * findings are being produced.
   */
  ANALYZING = 'analyzing',

  /**
   * Scan has finished successfully with results available.
   *
   * All accessibility issues have been identified, processed, and saved
   * to the database. Results can be retrieved through the API.
   */
  COMPLETED = 'completed',

  /**
   * Scan processing failed due to an error.
   *
   * The scan encountered an unrecoverable error during processing such as
   * page loading failure, browser crashes, or database issues. The scan
   * may be eligible for automatic retry depending on the error type.
   */
  FAILED = 'failed',

  /**
   * Scan was cancelled by an API client before it finished.
   *
   * A waiting job was removed from the queue, or a running scan observed the
   * cancellation between pages and stopped early. Partial results (if any) are
   * retained.
   */
  CANCELED = 'canceled',
}
