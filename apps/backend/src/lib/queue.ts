import { Queue } from "bullmq";
import { config } from "./config.js";

export const EXPORT_QUEUE_NAME = "export-jobs";

export const exportQueue = new Queue(EXPORT_QUEUE_NAME, {
  connection: { url: config.redisUrl, maxRetriesPerRequest: null },
});

export type ExportFormat = "MODS_ZIP" | "CURSEFORGE_ZIP";

export type ExportJobPayload = {
  jobId: string;
  modpackId: number;
  target: "CLIENT" | "SERVER" | "BOTH";
  format: ExportFormat;
  requestedAt: string;
};
