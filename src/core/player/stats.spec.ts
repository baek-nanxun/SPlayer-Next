import { createPinia, defineStore, setActivePinia } from "pinia";
import { nextTick, shallowRef, watch } from "vue";
import { expect, it, vi } from "vitest";
import type { Track } from "@shared/types/player";

vi.stubGlobal("watch", watch);
vi.mock("@/stores/media", () => ({
  useMediaStore: defineStore("test-stats-media", () => ({ track: shallowRef<Track | null>(null) })),
}));
vi.mock("@/stores/status", () => ({
  useStatusStore: defineStore("test-stats-status", () => ({ state: "playing" })),
}));
import { useMediaStore } from "@/stores/media";
import { installPlayStats, onTrackEnded } from "./stats";

it("封面晚到仍记录到同一播放会话，不新增次数或丢失听歌时长", async () => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  const recordPlay = vi.fn();
  window.api = { stats: { recordPlay } } as unknown as typeof window.api;
  const media = useMediaStore();
  installPlayStats();
  media.track = { id: "1", source: "netease", title: "歌曲", artists: [], duration: 10000 };
  await nextTick();
  vi.advanceTimersByTime(6000);
  media.track = { ...media.track, cover: "late-cover", album: { name: "专辑" } };
  await nextTick();
  expect(recordPlay).not.toHaveBeenCalled();
  vi.advanceTimersByTime(4000);
  onTrackEnded(false);
  expect(recordPlay).toHaveBeenCalledTimes(1);
  expect(recordPlay).toHaveBeenCalledWith({
    track: expect.objectContaining({ cover: "late-cover", album: { name: "专辑" } }),
    startedAt: expect.any(Number),
    listenedMs: 10000,
  });
  vi.useRealTimers();
});
