// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@shared/types/player";

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null }));
vi.mock("./index", () => ({ getDb: () => state.db, isDbOpen: () => true }));
vi.mock("@main/utils/logger", () => ({ libraryLog: { error: vi.fn() } }));
import { getTopTracks, insertPlayEvent } from "./playStats";

const track: Track = {
  source: "netease",
  id: "1",
  title: "旧标题",
  artists: [],
  duration: 1000,
};

/** 写入指定时刻的真实历史快照 */
const record = (value: Track, startedAt: number): void => {
  insertPlayEvent({ track: value, startedAt, listenedMs: 1000 });
};

describe("首页历史封面恢复", () => {
  beforeEach(() => {
    state.db = new DatabaseSync(":memory:");
    state.db.exec(`CREATE TABLE play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT, source TEXT,
      started_at INTEGER, listened_ms INTEGER, track_json TEXT
    )`);
  });
  afterEach(() => state.db?.close());

  it("简化的一起听记录从旧记录补齐封面和专辑，保留最新标题和播放次数", () => {
    record({ ...track, cover: "thumb", coverOriginal: "large", album: { name: "专辑" } }, 1);
    record({ ...track, title: "最新标题" }, 2);
    expect(getTopTracks(6)).toEqual([
      {
        track: {
          ...track,
          title: "最新标题",
          cover: "thumb",
          coverOriginal: "large",
          album: { name: "专辑" },
        },
        playCount: 2,
      },
    ]);
    expect(state.db?.prepare("SELECT COUNT(*) AS n FROM play_history").get()).toEqual({ n: 2 });
  });

  it("各字段独立补齐，忽略空字符串，不覆盖最新的有效字段", () => {
    record({ ...track, cover: "old", coverOriginal: "large", album: { name: "专辑" } }, 1);
    record({ ...track, cover: "new", album: { name: "" } }, 2);
    record({ ...track, cover: "", coverOriginal: " " }, 0);
    const result = getTopTracks(1)[0];
    expect(result?.track).toMatchObject({
      cover: "new",
      coverOriginal: "large",
      album: { name: "专辑" },
    });
    expect(result?.playCount).toBe(3);
  });

  it("按平台隔离同 ID，支持专辑封面兜底，完全缺失时保持占位而不猜错封面", () => {
    record({ ...track, album: { name: "专辑", cover: "album-cover" } }, 1);
    record({ ...track, source: "qqmusic", cover: "qq-cover" }, 2);
    record({ ...track, id: "2" }, 3);
    const results = getTopTracks(6);
    expect(results.map((item) => item.track.cover)).toEqual([undefined, "qq-cover", "album-cover"]);
    expect(getTopTracks(0)).toEqual([]);
  });

  it("时间相同使用最新插入快照，次数相同时按最近播放排序", () => {
    record({ ...track, title: "old" }, 2);
    record({ ...track, title: "new" }, 2);
    record({ ...track, id: "2" }, 1);
    record({ ...track, id: "2" }, 1);
    expect(getTopTracks(1)[0]).toMatchObject({ track: { id: "1", title: "new" }, playCount: 2 });
  });
});
