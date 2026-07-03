import { config } from "../lib/config.js";
import { db } from "../lib/db.js";
import { getMod, getModFile, getModFiles } from "./curseforge.js";

const MODLOADER_CODE: Record<string, number> = {
  Forge: 1,
  Fabric: 4,
  Quilt: 5,
  NeoForge: 6,
};

type AddResult = {
  created: any[];
  skipped: Array<{ curseforgeProjectId: number; reason: string }>;
};

export type ModpackProfile = "CLIENT" | "SERVER";

type AddContext = {
  modpackId: number;
  profile: ModpackProfile;
  versionMinecraft: string;
  modloaderTipo: string;
  visited: Set<number>;
  created: any[];
  skipped: Array<{ curseforgeProjectId: number; reason: string }>;
  depth: number;
};

async function getModMeta(modId: number): Promise<{ name: string; logoUrl: string | null }> {
  const modRes = await getMod(modId);
  return {
    name: modRes?.data?.name ?? `mod-${modId}`,
    logoUrl: modRes?.data?.logo?.thumbnailUrl ?? null,
  };
}

async function pickFileForDependency(modId: number, version: string, modloaderCode: number): Promise<number | null> {
  const filesRes = await getModFiles(modId, {
    gameVersion: version,
    modLoaderType: modloaderCode,
    index: 0,
    pageSize: 50,
  });

  const files = filesRes?.data ?? [];
  if (!Array.isArray(files) || files.length === 0) return null;
  return files[0]?.id ?? null;
}

async function insertModRow(params: {
  modpackId: number;
  profile: ModpackProfile;
  projectId: number;
  fileId: number;
  nombreMod: string;
  logoUrl: string | null;
  entornoDestino: "BOTH" | "CLIENT_ONLY" | "SERVER_ONLY";
  esDependencia: boolean;
  padreProyectoId: number | null;
}): Promise<any | null> {
  const existing = await db.query(
    "SELECT id FROM modpack_mods WHERE modpack_id = $1 AND curseforge_project_id = $2 AND profile = $3",
    [params.modpackId, params.projectId, params.profile],
  );

  if (existing.rowCount) return null;

  const insert = await db.query(
    `
      INSERT INTO modpack_mods
      (modpack_id, profile, curseforge_project_id, curseforge_file_id, nombre_mod, logo_url, entorno_destino, es_dependencia, padre_proyecto_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id, modpack_id AS "modpackId", curseforge_project_id AS "curseforgeProjectId",
                curseforge_file_id AS "curseforgeFileId", nombre_mod AS "nombreMod", logo_url AS "logoUrl",
                profile,
                entorno_destino AS "entornoDestino", es_dependencia AS "esDependencia",
                padre_proyecto_id AS "padreProyectoId"
    `,
    [
      params.modpackId,
      params.profile,
      params.projectId,
      params.fileId,
      params.nombreMod,
      params.logoUrl,
      params.entornoDestino,
      params.esDependencia,
      params.padreProyectoId,
    ],
  );

  return insert.rows[0];
}

async function resolveDependencies(
  ctx: AddContext,
  projectId: number,
  fileId: number,
  entornoDestino: "BOTH" | "CLIENT_ONLY" | "SERVER_ONLY",
  isDependency: boolean,
  parentProjectId: number | null,
): Promise<void> {
  if (ctx.depth > config.depResolveMaxDepth) {
    ctx.skipped.push({ curseforgeProjectId: projectId, reason: "max_depth_reached" });
    return;
  }

  if (ctx.visited.has(projectId)) {
    ctx.skipped.push({ curseforgeProjectId: projectId, reason: "already_visited" });
    return;
  }
  ctx.visited.add(projectId);

  const modMeta = await getModMeta(projectId);
  const row = await insertModRow({
    modpackId: ctx.modpackId,
    profile: ctx.profile,
    projectId,
    fileId,
    nombreMod: modMeta.name,
    logoUrl: modMeta.logoUrl,
    entornoDestino,
    esDependencia: isDependency,
    padreProyectoId: parentProjectId,
  });

  if (row) {
    ctx.created.push(row);
  } else {
    ctx.skipped.push({ curseforgeProjectId: projectId, reason: "already_exists" });
  }

  const fileRes = await getModFile(projectId, fileId);
  const dependencies = fileRes?.data?.dependencies ?? [];
  const requiredDeps = Array.isArray(dependencies)
    ? dependencies.filter((d: any) => d?.relationType === 3 && Number.isInteger(d?.modId))
    : [];

  const modloaderCode = MODLOADER_CODE[ctx.modloaderTipo] ?? 0;

  for (const dep of requiredDeps) {
    const depProjectId: number = dep.modId;
    const depFileId = await pickFileForDependency(depProjectId, ctx.versionMinecraft, modloaderCode);
    if (!depFileId) {
      ctx.skipped.push({ curseforgeProjectId: depProjectId, reason: "missing_compatible_file" });
      continue;
    }

    await resolveDependencies(
      { ...ctx, depth: ctx.depth + 1 },
      depProjectId,
      depFileId,
      "BOTH",
      true,
      projectId,
    );
  }
}

export async function addModWithDependencies(params: {
  modpackId: number;
  profile: ModpackProfile;
  curseforgeProjectId: number;
  curseforgeFileId: number;
  entornoDestino: "BOTH" | "CLIENT_ONLY" | "SERVER_ONLY";
}): Promise<AddResult> {
  const modpackRes = await db.query(
    "SELECT id, version_minecraft, modloader_tipo FROM modpacks WHERE id = $1",
    [params.modpackId],
  );

  if (!modpackRes.rowCount) {
    throw new Error("modpack_not_found");
  }

  const modpack = modpackRes.rows[0];
  const ctx: AddContext = {
    modpackId: params.modpackId,
    profile: params.profile,
    versionMinecraft: modpack.version_minecraft,
    modloaderTipo: modpack.modloader_tipo,
    visited: new Set<number>(),
    created: [],
    skipped: [],
    depth: 0,
  };

  await resolveDependencies(
    ctx,
    params.curseforgeProjectId,
    params.curseforgeFileId,
    params.entornoDestino,
    false,
    null,
  );

  return { created: ctx.created, skipped: ctx.skipped };
}

export function modloaderCodeFromTipo(tipo: string): number {
  return MODLOADER_CODE[tipo] ?? 0;
}
