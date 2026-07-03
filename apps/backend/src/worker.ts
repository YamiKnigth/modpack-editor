import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import * as archiver from "archiver";
import { Worker } from "bullmq";
import { config } from "./lib/config.js";
import { db } from "./lib/db.js";
import { EXPORT_QUEUE_NAME, type ExportJobPayload } from "./lib/queue.js";
import { getModFile, getModFileDownloadUrl } from "./services/curseforge.js";

const archiverFactory = ((archiver as any).default ?? archiver) as (
  format: string,
  options?: unknown,
) => any;

async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

function shouldInclude(target: "CLIENT" | "SERVER" | "BOTH", entorno: "BOTH" | "CLIENT_ONLY" | "SERVER_ONLY"): boolean {
  if (target === "BOTH") return true;
  if (target === "CLIENT") return entorno !== "SERVER_ONLY";
  return entorno !== "CLIENT_ONLY";
}

function shouldIncludeProfile(target: "CLIENT" | "SERVER" | "BOTH", profile: "CLIENT" | "SERVER"): boolean {
  if (target === "BOTH") return true;
  return target === profile;
}

async function downloadToFile(url: string, destination: string): Promise<void> {
  const response = await axios.get(url, { responseType: "stream", timeout: 60000 });
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(destination);
    response.data.pipe(out);
    out.on("finish", () => resolve());
    out.on("error", (err) => reject(err));
  });
}

async function buildZip(sourceModsDir: string, zipPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiverFactory("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    archive.on("error", (err: Error) => reject(err));

    archive.pipe(output);
    archive.directory(sourceModsDir, "mods");
    archive.finalize();
  });
}

function safeFileSegment(value: string | null | undefined, fallback: string): string {
  const clean = String(value ?? "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return clean || fallback;
}

function removeLeadingDuplicateModName(modName: string, versionLabel: string): string {
  const normalize = (v: string) =>
    v
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

  const modNorm = normalize(modName);
  const verNorm = normalize(versionLabel);
  if (!modNorm || !verNorm) return versionLabel;

  if (verNorm === modNorm) return versionLabel;
  if (!verNorm.startsWith(`${modNorm}-`)) return versionLabel;

  const cutRegex = new RegExp(`^${modName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[-_.\\s]*`, "i");
  const trimmed = versionLabel.replace(cutRegex, "").replace(/^[-_.\s]+/, "").trim();
  return trimmed || versionLabel;
}

function uniqueJarPath(modsDir: string, filename: string): string {
  const ext = path.extname(filename) || ".jar";
  const base = path.basename(filename, ext);
  let candidate = path.join(modsDir, `${base}${ext}`);
  let idx = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(modsDir, `${base}-${idx}${ext}`);
    idx += 1;
  }
  return candidate;
}

async function buildCurseforgeManifestZip(
  outputZip: string,
  info: {
    modpackName: string;
    minecraftVersion: string;
    modloaderTipo: string;
    modloaderVersion: string;
    mods: Array<{ curseforge_project_id: number; curseforge_file_id: number }>;
  },
): Promise<void> {
  const modLoaderId = (() => {
    const version = String(info.modloaderVersion ?? "").trim();
    if (info.modloaderTipo === "Forge") return `forge-${version}`;
    if (info.modloaderTipo === "Fabric") return `fabric-loader-${version}`;
    if (info.modloaderTipo === "Quilt") return `quilt-loader-${version}`;
    if (info.modloaderTipo === "NeoForge") return `neoforge-${version}`;
    return `forge-${version}`;
  })();

  const manifest = {
    minecraft: {
      version: info.minecraftVersion,
      modLoaders: [{ id: modLoaderId, primary: true }],
    },
    manifestType: "minecraftModpack",
    manifestVersion: 1,
    name: info.modpackName,
    version: "1.0.0",
    author: "CraftForge",
    files: info.mods.map((m) => ({
      projectID: Number(m.curseforge_project_id),
      fileID: Number(m.curseforge_file_id),
      required: true,
    })),
    overrides: "overrides",
  };

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outputZip);
    const archive = archiverFactory("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    archive.on("error", (err: Error) => reject(err));

    archive.pipe(output);
    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
    archive.append("", { name: "overrides/.keep" });
    archive.finalize();
  });
}

async function processExport(payload: ExportJobPayload): Promise<void> {
  await db.query(
    "UPDATE export_jobs SET status = 'running', started_at = NOW() WHERE id = $1",
    [payload.jobId],
  );

  const scratchBase = config.scratchBaseDir;
  const taskDir = path.join(scratchBase, payload.jobId);
  const modsDir = path.join(taskDir, "mods");
  const suffix = payload.format === "CURSEFORGE_ZIP" ? "curseforge" : "mods";
  const outputZip = path.join(taskDir, `modpack-${payload.modpackId}-${payload.target}-${suffix}.zip`);

  await ensureDir(modsDir);

  const modsRes = await db.query(
    `
    SELECT curseforge_project_id, curseforge_file_id, nombre_mod, entorno_destino, profile
    FROM modpack_mods
    WHERE modpack_id = $1
    ORDER BY id ASC
    `,
    [payload.modpackId],
  );

  const selectedMods = modsRes.rows.filter(
    (mod) => shouldIncludeProfile(payload.target, mod.profile) && shouldInclude(payload.target, mod.entorno_destino),
  );

  if (payload.format === "CURSEFORGE_ZIP") {
    const modpackRes = await db.query(
      `
      SELECT nombre, version_minecraft, modloader_tipo, modloader_version
      FROM modpacks
      WHERE id = $1
      LIMIT 1
      `,
      [payload.modpackId],
    );

    if (!modpackRes.rowCount) {
      throw new Error("modpack_not_found");
    }

    const pack = modpackRes.rows[0];
    await buildCurseforgeManifestZip(outputZip, {
      modpackName: String(pack.nombre ?? `Modpack ${payload.modpackId}`),
      minecraftVersion: String(pack.version_minecraft ?? "1.20.1"),
      modloaderTipo: String(pack.modloader_tipo ?? "Forge"),
      modloaderVersion: String(pack.modloader_version ?? ""),
      mods: selectedMods,
    });

    await db.query(
      `
      UPDATE export_jobs
      SET status = 'completed', finished_at = NOW(), scratch_dir = $2, output_file = $3
      WHERE id = $1
      `,
      [payload.jobId, taskDir, outputZip],
    );
    return;
  }

  for (const mod of selectedMods) {

    const dl = await getModFileDownloadUrl(mod.curseforge_project_id, mod.curseforge_file_id);
    const url = dl?.data;
    if (!url || typeof url !== "string") continue;

    const fileRes = await getModFile(Number(mod.curseforge_project_id), Number(mod.curseforge_file_id)).catch(() => null);
    const f = fileRes?.data;
    const modName = safeFileSegment(String(mod.nombre_mod ?? mod.curseforge_project_id), "mod");
    const rawVersion = String(f?.displayName ?? f?.fileName ?? mod.curseforge_file_id);
    const dedupVersion = removeLeadingDuplicateModName(String(mod.nombre_mod ?? ""), rawVersion);
    const versionLabel = safeFileSegment(dedupVersion, "version");
    const filename = `${modName}-${versionLabel}.jar`;
    const outputPath = uniqueJarPath(modsDir, filename);
    await downloadToFile(url, outputPath);
  }

  await buildZip(modsDir, outputZip);

  await db.query(
    `
    UPDATE export_jobs
    SET status = 'completed', finished_at = NOW(), scratch_dir = $2, output_file = $3
    WHERE id = $1
    `,
    [payload.jobId, taskDir, outputZip],
  );
}

async function cleanupScratch(): Promise<void> {
  const base = config.scratchBaseDir;
  await ensureDir(base);
  const entries = await fs.promises.readdir(base, { withFileTypes: true });
  const now = Date.now();
  const ttlMs = 120 * 60 * 1000;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(base, entry.name);
    const stat = await fs.promises.stat(full);
    if (now - stat.mtimeMs > ttlMs) {
      await fs.promises.rm(full, { recursive: true, force: true });
    }
  }
}

const worker = new Worker<ExportJobPayload>(
  EXPORT_QUEUE_NAME,
  async (job) => {
    try {
      await processExport(job.data);
    } catch (error: any) {
      await db.query(
        "UPDATE export_jobs SET status = 'failed', finished_at = NOW(), error_message = $2 WHERE id = $1",
        [job.data.jobId, String(error?.message ?? "unknown_error")],
      );
      throw error;
    }
  },
  {
    concurrency: config.workerMaxParallelDownloads,
    connection: { url: config.redisUrl, maxRetriesPerRequest: null },
  },
);

setInterval(() => {
  cleanupScratch().catch(() => {
    // noop on cleanup failures in V1
  });
}, 15 * 60 * 1000);

worker.on("ready", () => {
  console.log("queue-worker ready");
});

worker.on("failed", (job, err) => {
  console.error("queue-worker failed", { jobId: job?.id, err: err.message });
});
