import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { addModWithDependencies, modloaderCodeFromTipo, type ModpackProfile } from "../services/mods.js";
import {
  extractVideoUrlsFromHtml,
  getMod,
  getModDescription,
  getModFile,
  getModFiles,
  scrapeCurseforgeProjectPage,
  searchCurseforgeWebProjects,
  searchMods,
} from "../services/curseforge.js";

type SearchSortBy = "relevancy" | "default";
type WebSearchSortBy = "relevancy" | "featured" | "popularity" | "lastUpdated";

function normalizeTerm(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function relevancyScore(mod: any, normalizedSearch: string): number {
  if (!normalizedSearch) return 0;

  const name = normalizeTerm(mod?.name);
  const slug = normalizeTerm(mod?.slug);
  const summary = normalizeTerm(mod?.summary);
  let score = 0;

  if (name === normalizedSearch) score += 1200;
  if (name.startsWith(normalizedSearch)) score += 900;
  if (name.includes(` ${normalizedSearch}`)) score += 600;
  if (name.includes(normalizedSearch)) score += 400;
  if (slug.startsWith(normalizedSearch)) score += 350;
  if (slug.includes(normalizedSearch)) score += 250;
  if (summary.includes(normalizedSearch)) score += 120;

  const downloads = Number(mod?.downloadCount ?? 0);
  const popularityBoost = Number.isFinite(downloads) ? Math.min(downloads / 1_000_000, 50) : 0;
  score += popularityBoost;

  return score;
}

function sortModsByRelevancy(mods: any[], searchFilter: string): any[] {
  const normalizedSearch = normalizeTerm(searchFilter);
  if (!normalizedSearch) return mods;

  return [...mods].sort((a, b) => {
    const scoreDiff = relevancyScore(b, normalizedSearch) - relevancyScore(a, normalizedSearch);
    if (scoreDiff !== 0) return scoreDiff;

    const nameA = normalizeTerm(a?.name);
    const nameB = normalizeTerm(b?.name);
    return nameA.localeCompare(nameB);
  });
}

export const modpacksRouter = Router();

const createModpackSchema = z.object({
  nombre: z.string().min(3).max(150),
  versionMinecraft: z.string().min(3).max(20),
  modloaderTipo: z.enum(["Forge", "Fabric", "Quilt", "NeoForge"]),
  modloaderVersion: z.string().min(1).max(50),
});

const addModSchema = z.object({
  curseforgeProjectId: z.number().int().positive(),
  curseforgeFileId: z.number().int().positive(),
  profile: z.enum(["CLIENT", "SERVER"]).default("CLIENT"),
  entornoDestino: z.enum(["BOTH", "CLIENT_ONLY", "SERVER_ONLY"]),
});

function normalizeProfile(value: unknown): ModpackProfile {
  return String(value ?? "CLIENT").toUpperCase() === "SERVER" ? "SERVER" : "CLIENT";
}

function normalizeWebSortBy(value: unknown): WebSearchSortBy {
  const normalized = String(value ?? "relevancy").toLowerCase();
  if (normalized === "featured") return "featured";
  if (normalized === "popularity") return "popularity";
  if (normalized === "lastupdated") return "lastUpdated";
  return "relevancy";
}

async function fetchCompatibleFiles(
  modpack: { version_minecraft?: string; modloader_tipo?: string; versionMinecraft?: string; modloaderTipo?: string },
  projectId: number,
) {
  const version = modpack.version_minecraft ?? modpack.versionMinecraft ?? "";
  const modloader = modpack.modloader_tipo ?? modpack.modloaderTipo ?? "";
  const modLoaderType = modloaderCodeFromTipo(modloader);
  const filesRes = await getModFiles(projectId, {
    gameVersion: version,
    modLoaderType,
    index: 0,
    pageSize: 50,
  });

  return Array.isArray(filesRes?.data) ? filesRes.data : [];
}

const updateModVersionSchema = z.object({
  profile: z.enum(["CLIENT", "SERVER"]).default("CLIENT"),
  curseforgeFileId: z.number().int().positive(),
});

modpacksRouter.get("/", async (_req, res, next) => {
  try {
    const result = await db.query(
      `
      SELECT id, nombre,
             version_minecraft AS "versionMinecraft",
             modloader_tipo AS "modloaderTipo",
             modloader_version AS "modloaderVersion",
             created_at AS "createdAt",
             updated_at AS "updatedAt"
      FROM modpacks
      ORDER BY id DESC
      `,
    );
    res.json({ data: result.rows });
  } catch (error) {
    next(error);
  }
});

modpacksRouter.post("/", async (req, res, next) => {
  try {
    const data = createModpackSchema.parse(req.body);
    const result = await db.query(
      `
      INSERT INTO modpacks (nombre, version_minecraft, modloader_tipo, modloader_version)
      VALUES ($1,$2,$3,$4)
      RETURNING id, nombre,
                version_minecraft AS "versionMinecraft",
                modloader_tipo AS "modloaderTipo",
                modloader_version AS "modloaderVersion",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
      `,
      [data.nombre, data.versionMinecraft, data.modloaderTipo, data.modloaderVersion],
    );

    res.status(201).json({ data: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

modpacksRouter.get("/:modpackId", async (req, res, next) => {
  try {
    const requestedProfile = normalizeProfile(req.query.profile);
    const modpackId = Number(req.params.modpackId);
    const modpackRes = await db.query(
      `
      SELECT id, nombre,
             version_minecraft AS "versionMinecraft",
             modloader_tipo AS "modloaderTipo",
             modloader_version AS "modloaderVersion",
             created_at AS "createdAt",
             updated_at AS "updatedAt"
      FROM modpacks
      WHERE id = $1
      `,
      [modpackId],
    );

    if (!modpackRes.rowCount) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Modpack not found" } });
      return;
    }

    const modsRes = await db.query(
      `
      SELECT id,
             modpack_id AS "modpackId",
             profile,
             curseforge_project_id AS "curseforgeProjectId",
             curseforge_file_id AS "curseforgeFileId",
             nombre_mod AS "nombreMod",
             logo_url AS "logoUrl",
             entorno_destino AS "entornoDestino",
             es_dependencia AS "esDependencia",
             padre_proyecto_id AS "padreProyectoId"
      FROM modpack_mods
      WHERE modpack_id = $1
        AND profile = $2
      ORDER BY es_dependencia ASC, id ASC
      `,
      [modpackId, requestedProfile],
    );

    const modsWithVersion = await Promise.all(
      modsRes.rows.map(async (row) => {
        try {
          const currentFileRes = await getModFile(Number(row.curseforgeProjectId), Number(row.curseforgeFileId));
          const currentDisplayName = currentFileRes?.data?.displayName ?? `fileId ${row.curseforgeFileId}`;

          const compatibleFiles = await fetchCompatibleFiles(
            { version_minecraft: modpackRes.rows[0].versionMinecraft, modloader_tipo: modpackRes.rows[0].modloaderTipo },
            Number(row.curseforgeProjectId),
          );

          const newest = compatibleFiles[0];
          const newestId = newest?.id ? Number(newest.id) : null;
          const newestName = newest?.displayName ?? null;

          return {
            ...row,
            currentVersionDisplayName: currentDisplayName,
            hasUpdate: !!newestId && newestId !== Number(row.curseforgeFileId),
            latestVersionFileId: newestId,
            latestVersionDisplayName: newestName,
          };
        } catch {
          return {
            ...row,
            currentVersionDisplayName: `fileId ${row.curseforgeFileId}`,
            hasUpdate: false,
            latestVersionFileId: null,
            latestVersionDisplayName: null,
          };
        }
      }),
    );

    modsWithVersion.sort((a, b) => Number(b.hasUpdate) - Number(a.hasUpdate) || Number(a.id) - Number(b.id));

    const profileCountsRes = await db.query(
      `
      SELECT profile, COUNT(*)::INT AS total
      FROM modpack_mods
      WHERE modpack_id = $1
      GROUP BY profile
      `,
      [modpackId],
    );

    const profileCounts: Record<string, number> = { CLIENT: 0, SERVER: 0 };
    for (const row of profileCountsRes.rows) {
      profileCounts[String(row.profile)] = Number(row.total);
    }

    res.json({ data: { ...modpackRes.rows[0], profile: requestedProfile, profileCounts, mods: modsWithVersion } });
  } catch (error) {
    next(error);
  }
});

modpacksRouter.delete("/:modpackId", async (req, res, next) => {
  try {
    const modpackId = Number(req.params.modpackId);
    const result = await db.query("DELETE FROM modpacks WHERE id = $1", [modpackId]);
    if (!result.rowCount) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Modpack not found" } });
      return;
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

modpacksRouter.get("/../mods/search", async (_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Use /api/v1/mods/search" } });
});

modpacksRouter.post("/:modpackId/mods", async (req, res, next) => {
  try {
    const modpackId = Number(req.params.modpackId);
    const parsed = addModSchema.parse(req.body);
    const result = await addModWithDependencies({ modpackId, ...parsed });
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

modpacksRouter.post("/:modpackId/profiles/server/clone-from-client", async (req, res, next) => {
  try {
    const modpackId = Number(req.params.modpackId);

    const modpackRes = await db.query("SELECT id FROM modpacks WHERE id = $1", [modpackId]);
    if (!modpackRes.rowCount) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Modpack not found" } });
      return;
    }

    const copyRes = await db.query(
      `
      INSERT INTO modpack_mods
      (modpack_id, profile, curseforge_project_id, curseforge_file_id, nombre_mod, logo_url, entorno_destino, es_dependencia, padre_proyecto_id)
      SELECT modpack_id,
             'SERVER'::modpack_profile,
             curseforge_project_id,
             curseforge_file_id,
             nombre_mod,
             logo_url,
             entorno_destino,
             es_dependencia,
             padre_proyecto_id
      FROM modpack_mods
      WHERE modpack_id = $1
        AND profile = 'CLIENT'
      ON CONFLICT (modpack_id, curseforge_project_id, profile) DO NOTHING
      RETURNING id
      `,
      [modpackId],
    );

    res.status(201).json({ data: { copied: copyRes.rowCount ?? 0 } });
  } catch (error) {
    next(error);
  }
});

modpacksRouter.delete("/:modpackId/mods/:projectId", async (req, res, next) => {
  try {
    const modpackId = Number(req.params.modpackId);
    const projectId = Number(req.params.projectId);
    const profile = normalizeProfile(req.query.profile);

    const del = await db.query(
      `
      DELETE FROM modpack_mods
      WHERE modpack_id = $1
        AND curseforge_project_id = $2
        AND profile = $3
      `,
      [modpackId, projectId, profile],
    );

    if (!del.rowCount) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Manual mod not found" } });
      return;
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

modpacksRouter.get("/:modpackId/mods/:projectId/files", async (req, res, next) => {
  try {
    const modpackId = Number(req.params.modpackId);
    const projectId = Number(req.params.projectId);
    const profile = normalizeProfile(req.query.profile);

    const modpackRes = await db.query("SELECT version_minecraft, modloader_tipo FROM modpacks WHERE id = $1", [modpackId]);
    if (!modpackRes.rowCount) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Modpack not found" } });
      return;
    }

    const currentRes = await db.query(
      `
      SELECT curseforge_file_id
      FROM modpack_mods
      WHERE modpack_id = $1 AND curseforge_project_id = $2 AND profile = $3
      LIMIT 1
      `,
      [modpackId, projectId, profile],
    );

    if (!currentRes.rowCount) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Mod not found in profile" } });
      return;
    }

    const currentFileId = Number(currentRes.rows[0].curseforge_file_id);
    const files = await fetchCompatibleFiles(modpackRes.rows[0], projectId);
    const mapped = files.slice(0, 30).map((f: any) => ({
      fileId: Number(f.id),
      displayName: f.displayName ?? `fileId ${f.id}`,
      isCurrent: Number(f.id) === currentFileId,
    }));

    res.json({ data: mapped });
  } catch (error) {
    next(error);
  }
});

modpacksRouter.patch("/:modpackId/mods/:projectId", async (req, res, next) => {
  try {
    const modpackId = Number(req.params.modpackId);
    const projectId = Number(req.params.projectId);
    const payload = updateModVersionSchema.parse(req.body);

    const update = await db.query(
      `
      UPDATE modpack_mods
      SET curseforge_file_id = $4
      WHERE modpack_id = $1
        AND curseforge_project_id = $2
        AND profile = $3
      RETURNING id,
                modpack_id AS "modpackId",
                profile,
                curseforge_project_id AS "curseforgeProjectId",
                curseforge_file_id AS "curseforgeFileId"
      `,
      [modpackId, projectId, payload.profile, payload.curseforgeFileId],
    );

    if (!update.rowCount) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Mod not found in profile" } });
      return;
    }

    res.json({ data: update.rows[0] });
  } catch (error) {
    next(error);
  }
});

export const modsSearchRouter = Router();

modsSearchRouter.get("/search", async (req, res, next) => {
  try {
    const modpackId = Number(req.query.modpackId);
    if (!modpackId) {
      res.status(400).json({ error: { code: "BAD_REQUEST", message: "modpackId is required" } });
      return;
    }

    const modpackRes = await db.query(
      "SELECT version_minecraft, modloader_tipo FROM modpacks WHERE id = $1",
      [modpackId],
    );
    if (!modpackRes.rowCount) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Modpack not found" } });
      return;
    }

    const modpack = modpackRes.rows[0];
    const requestedSearchFilter = String(req.query.searchFilter ?? "").trim();
    const source = String(req.query.source ?? "web").toLowerCase();
    const profile = normalizeProfile(req.query.profile);
    const requestedSortBy = String(req.query.sortBy ?? "relevancy").toLowerCase();
    const sortBy: SearchSortBy = requestedSortBy === "default" ? "default" : "relevancy";
    const webSortBy = normalizeWebSortBy(req.query.sortBy);
    const requestedClassId = req.query.classId ? Number(req.query.classId) : 6;
    const pageSize = req.query.pageSize ? Math.min(Math.max(Number(req.query.pageSize), 1), 50) : 20;
    const page = req.query.page ? Math.max(Number(req.query.page), 1) : undefined;
    const index = page ? (page - 1) * pageSize : req.query.index ? Math.max(Number(req.query.index), 0) : 0;

    const includedRows = await db.query(
      `
      SELECT curseforge_project_id, profile
      FROM modpack_mods
      WHERE modpack_id = $1
      `,
      [modpackId],
    );

    const includedInCurrent = new Set<number>();
    const includedInOther = new Set<number>();
    for (const row of includedRows.rows) {
      const pid = Number(row.curseforge_project_id);
      if (String(row.profile) === profile) includedInCurrent.add(pid);
      else includedInOther.add(pid);
    }

    if (source === "web") {
      const webResult = await searchCurseforgeWebProjects({
        search: requestedSearchFilter,
        page: page ?? Math.floor(index / pageSize) + 1,
        pageSize,
        sortBy: webSortBy,
        classId: requestedClassId,
      });

      const mapped = {
        data: (webResult.data ?? [])
          .filter((m: any) => String(m.className ?? "").toLowerCase() === "mods")
          .map((m: any) => {
          const isIncluded = includedInCurrent.has(Number(m.projectId));
          const isInOtherProfile = includedInOther.has(Number(m.projectId));

          return {
            projectId: m.projectId,
            name: m.name,
            slug: m.projectSlug,
            className: m.className,
            summary: m.summary,
            authors: [],
            logoUrl: m.logoUrl,
            inclusionStatus: isIncluded ? "INCLUDED" : isInOtherProfile ? "ADDED_OTHER_PROFILE" : "AVAILABLE",
            latestFiles: m.fileId
              ? [
                  {
                    fileId: m.fileId,
                    displayName: `fileId ${m.fileId}`,
                  },
                ]
              : [],
          };
        }),
        pagination: {
          index,
          pageSize,
          totalCount: index + (webResult.data?.length ?? 0) + ((webResult.data?.length ?? 0) === pageSize ? 1 : 0),
        },
        criteria: {
          searchFilter: requestedSearchFilter,
          page: page ?? Math.floor(index / pageSize) + 1,
          index,
          pageSize,
          sortBy: webSortBy,
          classId: requestedClassId,
          profile,
          source: "web",
        },
      };

      res.json(mapped);
      return;
    }

    const params: Record<string, unknown> = {
      gameId: 432,
      classId: requestedClassId ?? 6,
      gameVersion: modpack.version_minecraft,
      modLoaderType: modloaderCodeFromTipo(modpack.modloader_tipo),
      searchFilter: requestedSearchFilter,
      categoryId: req.query.categoryId ? Number(req.query.categoryId) : undefined,
      index,
      pageSize,
    };

    const result = await searchMods(params);
    const sourceData = Array.isArray(result?.data) ? result.data : [];
    const sortedData = sortBy === "relevancy" ? sortModsByRelevancy(sourceData, requestedSearchFilter) : sourceData;

    const loaderCode = modloaderCodeFromTipo(modpack.modloader_tipo);
    const mapped = {
      data: sortedData
        .map((m: any) => {
          const latestFilesRaw = Array.isArray(m.latestFiles) ? m.latestFiles : [];

          const strictMatches = latestFilesRaw.filter(
            (f: any) =>
              Array.isArray(f.gameVersions) &&
              f.gameVersions.includes(modpack.version_minecraft) &&
              (loaderCode === 0 || Number(f.modLoaderType ?? 0) === loaderCode),
          );

          const versionMatches = latestFilesRaw.filter(
            (f: any) => Array.isArray(f.gameVersions) && f.gameVersions.includes(modpack.version_minecraft),
          );

          const latestFiles = strictMatches.length
            ? strictMatches
            : versionMatches.length
              ? versionMatches
              : latestFilesRaw;

          return {
            projectId: m.id,
            name: m.name,
            slug: m.slug ?? null,
            summary: m.summary,
            authors: Array.isArray(m.authors) ? m.authors.map((a: any) => a.name) : [],
            logoUrl: m.logo?.thumbnailUrl ?? null,
            inclusionStatus: includedInCurrent.has(Number(m.id))
              ? "INCLUDED"
              : includedInOther.has(Number(m.id))
                ? "ADDED_OTHER_PROFILE"
                : "AVAILABLE",
            latestFiles: latestFiles.slice(0, 3).map((f: any) => ({
              fileId: f.id,
              displayName: f.displayName,
            })),
          };
        }),
      pagination: result?.pagination ?? { index, pageSize, totalCount: 0 },
      criteria: {
        searchFilter: requestedSearchFilter,
        page,
        index,
        pageSize,
        sortBy,
        classId: requestedClassId,
        profile,
        source: "api",
      },
    };

    res.json(mapped);
  } catch (error) {
    next(error);
  }
});

modsSearchRouter.get("/:projectId", async (req, res, next) => {
  try {
    const projectId = Number(req.params.projectId);
    if (!projectId) {
      res.status(400).json({ error: { code: "BAD_REQUEST", message: "projectId invalido" } });
      return;
    }

    const modRes = await getMod(projectId);
    const m = modRes?.data;
    if (!m) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "Mod no encontrado" } });
      return;
    }

    const [descRes, pageData] = await Promise.all([
      getModDescription(projectId).catch(() => ({ data: null })),
      scrapeCurseforgeProjectPage(m.links?.websiteUrl ?? null),
    ]);

    const descriptionHtml = typeof descRes?.data === "string" ? descRes.data : null;
    const descriptionVideos = extractVideoUrlsFromHtml(descriptionHtml);
    const allVideos = Array.from(new Set([...(descriptionVideos ?? []), ...(pageData.pageVideos ?? [])])).slice(0, 20);

    const latestFiles = Array.isArray(m.latestFiles) ? m.latestFiles : [];
    const latestIndexes = Array.isArray(m.latestFilesIndexes) ? m.latestFilesIndexes : [];
    const categories = Array.isArray(m.categories) ? m.categories : [];
    const screenshots = Array.isArray(m.screenshots) ? m.screenshots : [];
    const gameVersionLatestFiles = Array.isArray(m.gameVersionLatestFiles) ? m.gameVersionLatestFiles : [];

    res.json({
      data: {
        projectId: m.id,
        name: m.name,
        slug: m.slug ?? null,
        summary: m.summary ?? null,
        logoUrl: m.logo?.thumbnailUrl ?? null,
        websiteUrl: m.links?.websiteUrl ?? null,
        links: {
          websiteUrl: m.links?.websiteUrl ?? null,
          wikiUrl: m.links?.wikiUrl ?? null,
          issuesUrl: m.links?.issuesUrl ?? null,
          sourceUrl: m.links?.sourceUrl ?? null,
        },
        classId: m.classId ?? null,
        gameId: m.gameId ?? null,
        logo: {
          url: m.logo?.url ?? null,
          thumbnailUrl: m.logo?.thumbnailUrl ?? null,
          title: m.logo?.title ?? null,
          description: m.logo?.description ?? null,
        },
        authors: Array.isArray(m.authors) ? m.authors.map((a: any) => a.name) : [],
        authorsDetailed: Array.isArray(m.authors)
          ? m.authors.map((a: any) => ({
              id: a.id ?? null,
              name: a.name ?? null,
              url: a.url ?? null,
              projectId: a.projectId ?? null,
              userId: a.userId ?? null,
              twitchId: a.twitchId ?? null,
            }))
          : [],
        categories: categories.map((c: any) => ({
          id: c.id,
          name: c.name,
          slug: c.slug ?? null,
          url: c.url ?? null,
          iconUrl: c.iconUrl ?? null,
          classId: c.classId ?? null,
        })),
        screenshots: screenshots.map((s: any) => ({
          id: s.id,
          title: s.title ?? null,
          description: s.description ?? null,
          thumbnailUrl: s.thumbnailUrl ?? null,
          url: s.url ?? null,
        })),
        descriptionHtml,
        videos: allVideos,
        stats: {
          downloadCount: m.downloadCount ?? null,
          thumbsUpCount: m.thumbsUpCount ?? null,
        },
        status: {
          allowModDistribution: m.allowModDistribution ?? null,
          gamePopularityRank: m.gamePopularityRank ?? null,
          isFeatured: m.isFeatured ?? null,
          isAvailable: m.isAvailable ?? null,
        },
        downloadCount: m.downloadCount ?? null,
        dateCreated: m.dateCreated ?? null,
        dateReleased: m.dateReleased ?? null,
        dateModified: m.dateModified ?? null,
        latestFiles: latestFiles.slice(0, 25).map((f: any) => ({
          id: f.id,
          displayName: f.displayName ?? null,
          fileName: f.fileName ?? null,
          fileDate: f.fileDate ?? null,
          releaseType: f.releaseType ?? null,
          fileStatus: f.fileStatus ?? null,
          isAvailable: f.isAvailable ?? null,
          gameVersions: Array.isArray(f.gameVersions) ? f.gameVersions.slice(0, 20) : [],
          downloadCount: f.downloadCount ?? null,
          fileLength: f.fileLength ?? null,
        })),
        latestFilesIndexes: latestIndexes.slice(0, 25),
        gameVersionLatestFiles: gameVersionLatestFiles.slice(0, 50),
      },
    });
  } catch (error) {
    next(error);
  }
});
