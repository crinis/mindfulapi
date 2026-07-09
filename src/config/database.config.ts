import { ConfigType } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';
import { databaseConfig } from './configuration';

/** Structural subset of the better-sqlite3 Database handle (no bundled types). */
interface SqliteDatabase {
  pragma(source: string): unknown;
}

/**
 * TypeORM configuration. Uses `synchronize: true` so the schema is always kept
 * in sync with the entity definitions automatically — no migration files needed.
 *
 * @param database Validated database namespace configuration.
 * @returns Fully resolved TypeORM module options.
 */
export const createDatabaseConfig = (
  database: ConfigType<typeof databaseConfig>,
): TypeOrmModuleOptions => ({
  type: 'better-sqlite3',
  database: database.path,
  entities: [Scan, Issue],
  synchronize: true,
  logging: database.logging,
  prepareDatabase: (db: SqliteDatabase) => {
    // WAL lets API reads proceed while the scan worker writes; NORMAL is the
    // recommended synchronous level under WAL. busy_timeout avoids SQLITE_BUSY
    // between the HTTP handlers and the queue worker. Foreign keys are off by
    // default in SQLite and required for ON DELETE CASCADE on issues.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
  },
});
