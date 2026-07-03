import { Pool } from "pg";
import { config } from "./config.js";

export const db = new Pool({ connectionString: config.databaseUrl });

export async function withTx<T>(fn: (client: Pool | any) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
