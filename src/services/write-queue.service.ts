import { Injectable } from '@nestjs/common';

/**
 * Runs the database writes that open a transaction one at a time, across
 * the whole process.
 *
 * TypeORM's better-sqlite3 driver runs every query on one shared
 * QueryRunner. A multi-row `save([...])` opens a transaction on it, and any
 * write issued while that transaction is open (by another scan, another AI
 * unit, another page) is written into it instead of committing on its own:
 * if the save then fails and rolls back, it takes those rows along, and the
 * other writer's rows can be committed as part of the failed save. The
 * multi-row saves — AI findings ({@link AgentAuditService}) and page issues
 * ({@link ScanProcessor}) — therefore go through this queue, so they never
 * overlap. Reads and single-statement writes do not use it.
 */
@Injectable()
export class WriteQueue {
  /** Settles after the last queued write. */
  private tail: Promise<void> = Promise.resolve();

  /**
   * Runs `write` once every write queued before it has settled.
   *
   * @returns What `write` returns; it rejects only when `write` fails, and
   * the next write still runs.
   */
  run<T>(write: () => Promise<T>): Promise<T> {
    const result = this.tail.then(write);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
