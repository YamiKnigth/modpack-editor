import fs from "node:fs";
import path from "node:path";
import { db } from "./lib/db.js";

async function migrate(): Promise<void> {
  const sqlPath = path.resolve(process.cwd(), "../../docs/sql/001_init.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await db.query(sql);
  console.log("Migration 001_init.sql applied");
  await db.end();
}

migrate().catch((error) => {
  console.error("Migration failed", error);
  process.exit(1);
});
