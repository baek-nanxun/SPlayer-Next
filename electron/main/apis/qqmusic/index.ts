/**
 * QQ 音乐主进程服务，统一分发账号、曲库与一起听请求
 * 账号写操作和房间状态绕过响应缓存，避免吞掉重复操作或返回过期状态
 */

import { createHash } from "node:crypto";
import { modules } from "./modules";
import { clearQQMusicCookies, mergeQQMusicCookies } from "./core/request";
import type { QMParams } from "./core/types";

export { clearQQMusicCookies, mergeQQMusicCookies };

/** 2 分钟响应缓存 */
const DEFAULT_TTL = 2 * 60 * 1000;
const MAX_ENTRIES = 200;

interface CacheEntry {
  value: unknown;
  expireAt: number;
}

const cache = new Map<string, CacheEntry>();

/** 不缓存的实时接口 */
const NON_CACHEABLE: ReadonlySet<string> = new Set([
  "account",
  "together",
  "user_detail",
  "song_url",
  "comment",
  "login_qr_key",
  "login_qr_check",
]);

const hashParams = (params: unknown): string =>
  createHash("md5")
    .update(JSON.stringify(params ?? {}))
    .digest("hex")
    .slice(0, 8);

const cacheGet = (key: string): unknown => {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expireAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
};

const cacheSet = (key: string, value: unknown, ttl = DEFAULT_TTL): void => {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expireAt: Date.now() + ttl });
};

export const clearQQMusicCache = (): void => {
  cache.clear();
};

/**
 * 调用已注册的 QQ 音乐接口
 * @param name - modules/index.ts 中注册的接口名称
 * @param params - 业务参数，账号与实时接口自动跳过缓存
 */
export const callQQMusic = async (name: string, params: QMParams = {}): Promise<any> => {
  // hasOwn 守卫
  const fn = Object.hasOwn(modules, name) ? modules[name] : undefined;
  if (!fn) throw new Error(`unknown qm api: ${name}`);

  if (NON_CACHEABLE.has(name)) return fn(params);

  const key = `${name}|${hashParams(params)}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  const value = await fn(params);
  cacheSet(key, value);
  return value;
};
