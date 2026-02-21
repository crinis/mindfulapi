import { DataSource } from 'typeorm';
import { createDatabaseConfig } from './config/database.config';

/** Used by TypeORM CLI commands (see package.json scripts). */
export const AppDataSource = new DataSource(createDatabaseConfig());
