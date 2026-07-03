import IORedis from "ioredis";
import { config } from "./config.js";

const RedisCtor = IORedis as unknown as new (
  url: string,
  options: { maxRetriesPerRequest: null },
) => any;

export const redis = new RedisCtor(config.redisUrl, { maxRetriesPerRequest: null });

export async function getCachedJson<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  return JSON.parse(raw) as T;
}

export async function setCachedJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
}
