import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import AdmZip from "adm-zip";
import { db } from "../lib/db.js";
import { getMod } from "../services/curseforge.js";
import { exportQueue, type ExportJobPayload } from "../lib/queue.js";

export const exportsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

const createExportSchema = z.object({
  target: z.enum(["CLIENT", "SERVER", "BOTH"]),
  format: z.enum(["MODS_ZIP", "CURSEFORGE_ZIP"]).default("MODS_ZIP"),
});

const importCurseforgeSchema = z.object({
  profile: z.enum(["CLIENT", "SERVER"]).default("CLIENT"),
  entornoDestino: z.enum(["BOTH", "CLIENT_ONLY", "SERVER_ONLY"]).default("BOTH"),
});

type ManifestFile = {
  projectID: number;
  fileID: number;
  required?: boolean;
};

type CurseforgeManifest = {
  name?: string;
  version?: string;
  minecraft?: {
    version?: string;
    modLoaders?: Array<{ id?: string; primary?: boolean }>;
  };
  files?: ManifestFile[];
};

function normalizeNameForImport(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 200);
}

exportsRouter.post("/modpacks/:modpackId/exports", async (req, res, next) => {
  try {
    const modpackId = Number(req.params.modpackId);
    const payload = createExportSchema.parse(req.body);

    const modpackRes = await db.query("SELECT id FROM modpacks WHERE id = $1", [modpackId]);
    if (!modpackRes.rowCount) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Modpack not found" } });
      return;
    }

    const jobRes = await db.query(
      `
      INSERT INTO export_jobs (modpack_id, target, format, status)
      VALUES ($1, $2, $3, 'queued')
      RETURNING id, modpack_id AS "modpackId", target, format, status, output_file AS "outputPath",
                error_message AS "errorMessage", created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"
      `,
      [modpackId, payload.target, payload.format],
    );

    const job = jobRes.rows[0];
    const message: ExportJobPayload = {
      jobId: job.id,
      modpackId: job.modpackId,
      target: job.target,
      format: job.format,
      requestedAt: job.createdAt,
    };

    await exportQueue.add("export", message, {
      jobId: message.jobId,
      removeOnComplete: 50,
      removeOnFail: 100,
    });

    res.status(202).json({ data: job });
  } catch (error) {
    next(error);
  }
});

exportsRouter.get("/exports/:jobId", async (req, res, next) => {
  try {
    const jobId = req.params.jobId;
    const result = await db.query(
      `
      SELECT id, modpack_id AS "modpackId", target, status,
              format,
             output_file AS "outputPath", error_message AS "errorMessage",
             created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"
      FROM export_jobs
      WHERE id = $1
      `,
      [jobId],
    );

    if (!result.rowCount) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Job not found" } });
      return;
    }

    res.json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

exportsRouter.get("/exports/:jobId/download", async (req, res, next) => {
  try {
    const jobId = req.params.jobId;
    const result = await db.query(
      `
      SELECT output_file, status
      FROM export_jobs
      WHERE id = $1
      `,
      [jobId],
    );

    if (!result.rowCount) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Job not found" } });
      return;
    }

    const job = result.rows[0];
    if (job.status !== "completed" || !job.output_file) {
      res.status(409).json({ error: { code: "JOB_NOT_COMPLETED", message: "Export not ready" } });
      return;
    }

    res.download(job.output_file);
  } catch (error) {
    next(error);
  }
});

exportsRouter.post("/modpacks/:modpackId/imports/curseforge", upload.single("file"), async (req, res, next) => {
  try {
    const modpackId = Number(req.params.modpackId);
    const input = importCurseforgeSchema.parse({
      profile: req.body?.profile,
      entornoDestino: req.body?.entornoDestino,
    });

    const modpackRes = await db.query("SELECT id FROM modpacks WHERE id = $1", [modpackId]);
    if (!modpackRes.rowCount) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Modpack not found" } });
      return;
    }

    if (!req.file?.buffer || !req.file.originalname?.toLowerCase().endsWith(".zip")) {
      res.status(400).json({ error: { code: "BAD_REQUEST", message: "Debes subir un archivo .zip de CurseForge" } });
      return;
    }

    const zip = new AdmZip(req.file.buffer);
    const manifestEntry = zip
      .getEntries()
      .find((entry) => !entry.isDirectory && entry.entryName.toLowerCase() === "manifest.json");

    if (!manifestEntry) {
      res.status(400).json({ error: { code: "BAD_REQUEST", message: "ZIP invalido: falta manifest.json" } });
      return;
    }

    const manifest = JSON.parse(manifestEntry.getData().toString("utf8")) as CurseforgeManifest;
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    if (!files.length) {
      res.status(400).json({ error: { code: "BAD_REQUEST", message: "manifest.json no contiene archivos" } });
      return;
    }

    const created: Array<{ projectId: number; fileId: number; name: string }> = [];
    const skipped: Array<{ projectId: number; fileId: number; reason: string }> = [];
    const failed: Array<{ projectId: number; fileId: number; reason: string }> = [];

    for (const file of files) {
      const projectId = Number(file?.projectID);
      const fileId = Number(file?.fileID);
      if (!Number.isFinite(projectId) || !Number.isFinite(fileId) || projectId <= 0 || fileId <= 0) {
        skipped.push({ projectId, fileId, reason: "invalid_manifest_entry" });
        continue;
      }

      try {
        const modRes = await getMod(projectId);
        const mod = modRes?.data;
        const name = normalizeNameForImport(String(mod?.name ?? `project-${projectId}`));
        const logoUrl = mod?.logo?.thumbnailUrl ?? null;

        const insertRes = await db.query(
          `
          INSERT INTO modpack_mods
          (modpack_id, profile, curseforge_project_id, curseforge_file_id, nombre_mod, logo_url, entorno_destino, es_dependencia, padre_proyecto_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NULL)
          ON CONFLICT (modpack_id, curseforge_project_id, profile) DO NOTHING
          RETURNING id
          `,
          [modpackId, input.profile, projectId, fileId, name, logoUrl, input.entornoDestino],
        );

        if (!insertRes.rowCount) {
          skipped.push({ projectId, fileId, reason: "already_exists" });
          continue;
        }

        created.push({ projectId, fileId, name });
      } catch (error: any) {
        failed.push({
          projectId,
          fileId,
          reason: String(error?.message ?? "unknown_error"),
        });
      }
    }

    res.status(201).json({
      data: {
        modpackId,
        importedFrom: req.file.originalname,
        manifestName: manifest.name ?? null,
        manifestVersion: manifest.version ?? null,
        profile: input.profile,
        entornoDestino: input.entornoDestino,
        totalManifestFiles: files.length,
        created,
        skipped,
        failed,
      },
    });
  } catch (error) {
    next(error);
  }
});
