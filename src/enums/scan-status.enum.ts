/**
 * Enumeration of accessibility scan processing states throughout the lifecycle.
 * 
 * This enum tracks the progression of accessibility scans from creation through
 * completion, enabling real-time status monitoring and result availability
 * indication for API consumers.
 * 
 * The status progression follows a predictable flow: PENDING → RUNNING → (COMPLETED | FAILED)
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
   * Scan is currently being processed by a background worker.
   * 
   * Browser automation is active, the page is being analyzed, and
   * accessibility issues are being identified and documented.
   */
  RUNNING = 'running',
  
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
}
