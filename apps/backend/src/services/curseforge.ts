import axios from "axios";
import { config } from "../lib/config.js";
import { getCachedJson, setCachedJson } from "../lib/redis.js";

export type CurseforgeWebSearchSortBy = "relevancy" | "featured" | "popularity" | "lastUpdated";

export type CurseforgeWebProject = {
  projectId: number;
  projectSlug: string | null;
  className: string | null;
  fileId: number | null;
  name: string;
  summary: string | null;
  logoUrl: string | null;
};

const cf = axios.create({
  baseURL: config.curseforgeBaseUrl,
  headers: {
    Accept: "application/json",
    "x-api-key": config.curseforgeApiKey,
  },
  timeout: 30000,
});

export async function cfGet<T>(url: string, params?: Record<string, unknown>, ttl = config.cacheTtlSeconds): Promise<T> {
  const cacheKey = `cf:${url}:${JSON.stringify(params ?? {})}`;
  const hit = await getCachedJson<T>(cacheKey);
  if (hit) return hit;

  const response = await cf.get<T>(url, { params });
  await setCachedJson(cacheKey, response.data, ttl);
  return response.data;
}

export async function getMinecraftVersions(): Promise<any> {
  return cfGet("/v1/minecraft/version", undefined, config.cacheTtlSeconds);
}

export async function getMinecraftModloaders(params?: {
  version?: string;
  includeAll?: boolean;
}): Promise<any> {
  return cfGet("/v1/minecraft/modloader", params, config.cacheTtlSeconds);
}

export async function searchMods(params: Record<string, unknown>): Promise<any> {
  return cfGet("/v1/mods/search", params, 600);
}

export async function getMod(modId: number): Promise<any> {
  return cfGet(`/v1/mods/${modId}`, undefined, 3600);
}

export async function getModDescription(modId: number): Promise<any> {
  return cfGet(`/v1/mods/${modId}/description`, undefined, 1800);
}

export async function getModFiles(modId: number, params?: Record<string, unknown>): Promise<any> {
  return cfGet(`/v1/mods/${modId}/files`, params, 600);
}

export async function getModFile(modId: number, fileId: number): Promise<any> {
  return cfGet(`/v1/mods/${modId}/files/${fileId}`, undefined, 600);
}

export async function getModFileDownloadUrl(modId: number, fileId: number): Promise<any> {
  return cfGet(`/v1/mods/${modId}/files/${fileId}/download-url`, undefined, 600);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function extractVideoUrlsFromHtml(html: string | null | undefined): string[] {
  const source = String(html ?? "");
  if (!source) return [];

  const urls: string[] = [];

  const rawUrlRegex = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[\w-]{6,}|youtu\.be\/[\w-]{6,}|player\.vimeo\.com\/video\/\d+|vimeo\.com\/\d+|streamable\.com\/[\w-]+)/gi;
  for (const match of source.matchAll(rawUrlRegex)) {
    if (match[0]) urls.push(match[0]);
  }

  const iframeSrcRegex = /<iframe[^>]+src=["']([^"']+)["'][^>]*>/gi;
  for (const match of source.matchAll(iframeSrcRegex)) {
    if (!match[1]) continue;
    const src = decodeRscText(match[1]);
    if (/youtube\.com|youtu\.be|vimeo\.com|streamable\.com/i.test(src)) {
      urls.push(src);
    }
  }

  const videoSrcRegex = /<video[^>]+src=["']([^"']+)["'][^>]*>/gi;
  for (const match of source.matchAll(videoSrcRegex)) {
    if (match[1]) urls.push(decodeRscText(match[1]));
  }

  return uniqueStrings(urls).slice(0, 20);
}

export async function scrapeCurseforgeProjectPage(websiteUrl: string | null | undefined): Promise<{
  pageVideos: string[];
}> {
  const url = String(websiteUrl ?? "").trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return { pageVideos: [] };
  }

  const cacheKey = `cf:web-page:v1:${url}`;
  const hit = await getCachedJson<{ pageVideos: string[] }>(cacheKey);
  if (hit) return hit;

  try {
    const response = await axios.get<string>(url, {
      headers: {
        Accept: "text/html,*/*",
        "User-Agent": "Mozilla/5.0",
      },
      timeout: 30000,
      responseType: "text",
    });

    const data = {
      pageVideos: extractVideoUrlsFromHtml(response.data),
    };
    await setCachedJson(cacheKey, data, 1800);
    return data;
  } catch {
    return { pageVideos: [] };
  }
}

function decodeRscText(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(/\\u0026/g, "&")
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n");
}

function classSlugFromClassId(classId?: number): string | undefined {
  if (!classId) return undefined;
  if (classId === 6) return "mc-mods";
  if (classId === 4471) return "modpacks";
  if (classId === 12) return "resource-packs";
  if (classId === 17) return "worlds";
  return undefined;
}

function parseRscProjectCards(payload: string): CurseforgeWebProject[] {
  const marker = '"className":" project-card"';
  const markers: number[] = [];
  let cursor = payload.indexOf(marker);
  while (cursor !== -1) {
    markers.push(cursor);
    cursor = payload.indexOf(marker, cursor + marker.length);
  }

  const segments = markers.map((start, index) => payload.slice(start, markers[index + 1] ?? payload.length));
  const projects: CurseforgeWebProject[] = [];

  for (const segment of segments) {
    const projectIdMatch = segment.match(/"projectId":(\d+)/);
    const fileIdMatch = segment.match(/"fileId":(\d+)/);
    const slugMatch = segment.match(/"projectSlug":"([^"]+)"/);
    const classMatch = segment.match(/"class-tag-overlay","children":"([^"]+)"/);
    const nameMatch = segment.match(/"className":"name"[\s\S]*?"className":"ellipsis","children":"([^"]+)"/);
    const summaryMatch = segment.match(/"className":"description","children":"([^"]*)"/);
    const logoMatch = segment.match(/"img":"([^"]+)"/);

    if (!projectIdMatch || !nameMatch) continue;

    projects.push({
      projectId: Number(projectIdMatch[1]),
      projectSlug: decodeRscText(slugMatch?.[1] ?? "") || null,
      className: decodeRscText(classMatch?.[1] ?? "") || null,
      fileId: fileIdMatch ? Number(fileIdMatch[1]) : null,
      name: decodeRscText(nameMatch[1]),
      summary: decodeRscText(summaryMatch?.[1] ?? "") || null,
      logoUrl: decodeRscText(logoMatch?.[1] ?? "") || null,
    });
  }

  const dedup = new Map<number, CurseforgeWebProject>();
  for (const project of projects) {
    if (!dedup.has(project.projectId)) dedup.set(project.projectId, project);
  }
  return Array.from(dedup.values());
}

export async function searchCurseforgeWebProjects(params: {
  search?: string;
  page?: number;
  pageSize?: number;
  sortBy?: CurseforgeWebSearchSortBy;
  classId?: number;
}): Promise<{ data: CurseforgeWebProject[]; pagination: { page: number; pageSize: number } }> {
  const page = Math.max(1, Number(params.page ?? 1));
  const pageSize = Math.min(50, Math.max(1, Number(params.pageSize ?? 20)));
  const sortBy = params.sortBy ?? "relevancy";

  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    sortBy,
  });

  const search = String(params.search ?? "").trim();
  if (search) query.set("search", search);

  const classSlug = classSlugFromClassId(params.classId);
  if (classSlug) query.set("class", classSlug);

  const endpointPath = `/minecraft/search?${query.toString()}`;
  const cacheKey = `cf:web-search:v2:${endpointPath}`;
  const hit = await getCachedJson<{ data: CurseforgeWebProject[]; pagination: { page: number; pageSize: number } }>(
    cacheKey,
  );
  if (hit) return hit;

  const response = await axios.get<string>(`https://www.curseforge.com${endpointPath}`, {
    headers: {
      Accept: "*/*",
      "User-Agent": "Mozilla/5.0",
      rsc: "1",
      "next-url": endpointPath,
    },
    timeout: 30000,
    responseType: "text",
  });

  const parsed = {
    data: parseRscProjectCards(response.data),
    pagination: { page, pageSize },
  };

  await setCachedJson(cacheKey, parsed, 600);
  return parsed;
}
