import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'matricarmz',
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  // Pool tuning (important for concurrency and avoiding connection storms)
  max: Number(process.env.PGPOOL_MAX ?? 10),
  idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_TIMEOUT_MS ?? 30_000),
  connectionTimeoutMillis: Number(process.env.PGPOOL_CONN_TIMEOUT_MS ?? 5_000),
});

export const db = drizzle(pool);


