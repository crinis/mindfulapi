import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSourceOptions } from 'typeorm';
import { Scan } from '../entities/scan.entity';
import { Issue } from '../entities/issue.entity';

/**
 * Shared TypeORM configuration for both NestJS module and CLI operations.
 * This ensures consistency between development and production environments.
 */
export const createDatabaseConfig = (): TypeOrmModuleOptions & DataSourceOptions => {
  const isProduction = process.env.NODE_ENV === 'production';
  
  return {
    type: 'sqlite',
    database: process.env.DATABASE_PATH || './data/database.sqlite',
    entities: [Scan, Issue],
    // Use different migration paths for development vs production
    migrations: isProduction 
      ? ['dist/migrations/*.js']
      : ['src/migrations/*.ts'],
    migrationsTableName: 'migrations',
    // Auto-sync database schema in development (disable in production)
    synchronize: !isProduction,
    // Run migrations automatically in production
    migrationsRun: isProduction,
    // Enable SQL logging in development for debugging
    logging: !isProduction,
  };
};
