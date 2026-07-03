import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

function readSecretApiKey(): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), "secret.properties"),
    path.resolve(process.cwd(), "../../secret.properties"),
    path.resolve("/app/secret.properties"),
  ];

  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, "utf8");
    const line = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.toLowerCase().startsWith("api_key"));
    if (!line) continue;
    const match = line.match(/^API_KEY\s*[:=]\s*(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

const apiKey = process.env.CURSEFORGE_API_KEY ?? readSecretApiKey();

if (!apiKey) {
  throw new Error("Missing CURSEFORGE_API_KEY and API_KEY in secret.properties");
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://craftforge_admin:password_seguro_local@localhost:5432/craftforge_db",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  curseforgeBaseUrl: process.env.CURSEFORGE_BASE_URL ?? "https://api.curseforge.com",
  curseforgeApiKey: apiKey,
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 86400),
  depResolveMaxDepth: Number(process.env.DEP_RESOLVE_MAX_DEPTH ?? 20),
  workerMaxParallelDownloads: Number(process.env.WORKER_MAX_PARALLEL_DOWNLOADS ?? 3),
  scratchBaseDir: process.env.SCRATCH_BASE_DIR ?? path.resolve(process.cwd(), "scratch"),
  jwtSecret: process.env.JWT_SECRET ?? "change_me_in_production",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "12h",
};
