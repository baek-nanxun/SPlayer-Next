import { expect, it, vi } from "vitest";
const call = vi.hoisted(() => vi.fn());
vi.mock("@/apis/qqmusic", () => ({ qqmusicCall: call }));
import { fetchQQAccountPlaylist } from "./qqmusic";

it("分页歌单保持 MID、数字 ID 和毫秒单位", async () => {
  call.mockReset();
  call.mockResolvedValueOnce({
    songs: [{ id: 1, mid: "first", interval: 10, title: "one" }],
    total: 2,
    hasMore: true,
  });
  call.mockResolvedValueOnce({
    songs: [{ id: 2, mid: "second", interval: 20, title: "two" }],
    total: 2,
    hasMore: false,
  });
  const result = await fetchQQAccountPlaylist("123");
  expect(result.tracks.map((track) => [track.id, track.extId, track.duration])).toEqual([
    ["first", "1", 10000],
    ["second", "2", 20000],
  ]);
  expect(call.mock.calls[1][1].offset).toBe(1);
});

it("不把缺页响应当作完整歌单", async () => {
  call.mockReset();
  call.mockResolvedValue({ songs: [], total: 5, hasMore: true });
  await expect(fetchQQAccountPlaylist("123")).rejects.toThrow("分页不完整");
});

it("取消读取后不回调旧页面", async () => {
  call.mockReset();
  const controller = new AbortController();
  call.mockImplementation(async () => {
    controller.abort();
    return { songs: [], total: 0, hasMore: false };
  });
  const onBatch = vi.fn();
  await expect(
    fetchQQAccountPlaylist("123", { signal: controller.signal, onBatch }),
  ).rejects.toThrow();
  expect(onBatch).not.toHaveBeenCalled();
});
