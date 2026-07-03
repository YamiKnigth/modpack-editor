import { Router } from "express";
import { getMinecraftModloaders, getMinecraftVersions } from "../services/curseforge.js";

export const systemRouter = Router();

type LoaderFamily = "Forge" | "Fabric" | "Quilt" | "NeoForge";

function normalizeFamilyFromType(type: number, rawName: string): LoaderFamily | null {
  if (type === 1) return "Forge";
  if (type === 4) return "Fabric";
  if (type === 5) return "Quilt";
  if (type === 6) return "NeoForge";

  const name = rawName.toLowerCase();
  if (name.startsWith("forge-")) return "Forge";
  if (name.startsWith("fabric-")) return "Fabric";
  if (name.startsWith("quilt-")) return "Quilt";
  if (name.startsWith("neoforge-") || name.startsWith("neo-forge-")) return "NeoForge";
  return null;
}

function extractLoaderVersion(rawName: string, versionMinecraft: string, family: LoaderFamily): string {
  const prefix = `${family.toLowerCase()}-`;
  let value = rawName.toLowerCase().startsWith(prefix) ? rawName.slice(prefix.length) : rawName;

  const suffix = `-${versionMinecraft}`;
  if (value.endsWith(suffix)) {
    value = value.slice(0, value.length - suffix.length);
  }

  return value;
}

async function fetchNormalizedModloaders(filters: {
  versionMinecraft?: string;
  loaderFamily?: string;
}): Promise<
  Array<{
    loaderFamily: LoaderFamily;
    loaderVersion: string;
    versionMinecraft: string;
    latest: boolean;
    recommended: boolean;
    rawName: string;
  }>
> {
  const result = await getMinecraftModloaders({
    version: filters.versionMinecraft,
    includeAll: true,
  });

  const dedupe = new Set<string>();
  return Array.isArray(result?.data)
    ? result.data
        .map((m: any) => {
          const family =
            typeof m?.name === "string"
              ? normalizeFamilyFromType(Number(m?.type ?? 0), m.name)
              : null;
          if (!family || typeof m?.gameVersion !== "string") return null;

          const loaderVersion = extractLoaderVersion(String(m.name), m.gameVersion, family);
          const key = `${m.gameVersion}::${family}::${loaderVersion}`;
          if (dedupe.has(key)) return null;
          dedupe.add(key);

          return {
            loaderFamily: family,
            loaderVersion,
            versionMinecraft: m.gameVersion,
            latest: Boolean(m.latest),
            recommended: Boolean(m.recommended),
            rawName: String(m.name),
          };
        })
        .filter((m: any) => m !== null)
        .filter((m: any) =>
          filters.versionMinecraft ? m.versionMinecraft === filters.versionMinecraft : true,
        )
        .filter((m: any) => (filters.loaderFamily ? m.loaderFamily === filters.loaderFamily : true))
        .sort(
          (a: any, b: any) =>
            Number(b.recommended) - Number(a.recommended) || Number(b.latest) - Number(a.latest),
        )
    : [];
}

systemRouter.get("/minecraft/versions", async (_req, res, next) => {
  try {
    const result = await getMinecraftVersions();
    const unique = new Set<string>();
    const data = Array.isArray(result?.data)
      ? result.data
          .filter((v: any) => typeof v?.versionString === "string")
          .map((v: any) => v.versionString)
          // Filtramos versiones java tipicas para evitar ruido de catalogo.
          .filter((version: string) => /^1\.\d+(\.\d+)?$/.test(version))
          .filter((version: string) => {
            if (unique.has(version)) return false;
            unique.add(version);
            return true;
          })
      : [];
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

systemRouter.get("/minecraft/modloaders", async (req, res, next) => {
  try {
    const versionFilter =
      typeof req.query.versionMinecraft === "string" ? req.query.versionMinecraft : undefined;
    const familyFilter =
      typeof req.query.loaderFamily === "string" ? req.query.loaderFamily : undefined;

    const data = await fetchNormalizedModloaders({
      versionMinecraft: versionFilter,
      loaderFamily: familyFilter,
    });
    res.json({ data });
  } catch (error) {
    next(error);
  }
});

systemRouter.get("/minecraft/loaders-cascade", async (req, res, next) => {
  try {
    const versionMinecraft =
      typeof req.query.versionMinecraft === "string" ? req.query.versionMinecraft : undefined;
    if (!versionMinecraft) {
      res.status(400).json({
        error: { code: "BAD_REQUEST", message: "versionMinecraft is required" },
      });
      return;
    }

    const loaders = await fetchNormalizedModloaders({ versionMinecraft });
    const grouped = new Map<LoaderFamily, typeof loaders>();

    for (const loader of loaders) {
      if (!grouped.has(loader.loaderFamily)) {
        grouped.set(loader.loaderFamily, []);
      }
      grouped.get(loader.loaderFamily)?.push(loader);
    }

    const data = {
      versionMinecraft,
      loaderFamilies: Array.from(grouped.entries()).map(([loaderFamily, versions]) => ({
        loaderFamily,
        versions,
      })),
    };

    res.json({ data });
  } catch (error) {
    next(error);
  }
});
