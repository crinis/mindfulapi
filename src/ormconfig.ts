import { DataSource } from 'typeorm';
import { createDatabaseConfig } from './config/database.config';

export const AppDataSource = new DataSource(createDatabaseConfig());
