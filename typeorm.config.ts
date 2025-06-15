import { DataSource } from 'typeorm';
import { Scan } from './src/entities/scan.entity';
import { Issue } from './src/entities/issue.entity';

const AppDataSource = new DataSource({
  type: 'sqlite',
  database: process.env.DATABASE_PATH || './data/database.sqlite',
  entities: [Scan, Issue],
  migrations: ['./src/migrations/*.ts'],
  synchronize: false,
  logging: process.env.NODE_ENV !== 'production',
});

export default AppDataSource;
