import express from "express";
import cors from "cors";
import pino from "pino";
import pinoHttp from "pino-http";
import { ZodError } from "zod";
import { config } from "./lib/config.js";
import { db } from "./lib/db.js";
import { modpacksRouter, modsSearchRouter } from "./routes/modpacks.js";
import { systemRouter } from "./routes/system.js";
import { exportsRouter } from "./routes/exports.js";
import { authRouter } from "./routes/auth.js";
import { requireAuth } from "./middleware/auth.js";

const logger = pino({ level: "info" });
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
const httpLogger = (pinoHttp as unknown as typeof pinoHttp.default)({
  logger,
  customProps: (req: express.Request, res: express.Response) => ({
    route: req.url,
    statusCode: res.statusCode,
  }),
});
app.use(
  httpLogger,
);

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/v1/auth", authRouter);
app.use("/api/v1/system", systemRouter);
app.use("/api/v1/modpacks", requireAuth, modpacksRouter);
app.use("/api/v1/mods", requireAuth, modsSearchRouter);
app.use("/api/v1", requireAuth, exportsRouter);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: "BAD_REQUEST", message: err.issues[0]?.message ?? "Invalid payload" } });
    return;
  }

  if (err instanceof Error && err.message === "modpack_not_found") {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Modpack not found" } });
    return;
  }

  reqLog(_req).error({ err }, "Unhandled error");
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Unexpected error" } });
});

function reqLog(req: express.Request) {
  return (req as any).log ?? logger;
}

async function start() {
  await db.query("SELECT 1");
  app.listen(config.port, () => {
    logger.info({ port: config.port }, "backend-api listening");
  });
}

start().catch((error) => {
  logger.error({ err: error }, "Failed to start backend-api");
  process.exit(1);
});
