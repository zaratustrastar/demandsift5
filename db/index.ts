import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./postgres/schema";

let client: ReturnType<typeof postgres> | null = null;
let database: ReturnType<typeof drizzle<typeof schema>> | null = null;

/** Typed PostgreSQL access for the DigitalOcean web service and worker. */
export function getDb(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for PostgreSQL access.");
  }
  if (!client || !database) {
    client = postgres(connectionString, {
      max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    });
    database = drizzle(client, { schema });
  }
  return database;
}

export async function closeDb() {
  await client?.end({ timeout: 5 });
  client = null;
  database = null;
}
