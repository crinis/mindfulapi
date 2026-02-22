import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';

/**
 * TypeORM configuration. Uses `synchronize: true` so the schema is always kept
 * in sync with the entity definitions automatically — no migration files needed.
 *
 * @returns Fully resolved TypeORM module options.
 */
export const createDatabaseConfig = (): TypeOrmModuleOptions => ({
  type: 'sqlite',
  database: process.env.DATABASE_PATH || './data/database.sqlite',
  entities: [Scan, Issue],
  synchronize: true,
  logging: process.env.NODE_ENV !== 'production',
});
