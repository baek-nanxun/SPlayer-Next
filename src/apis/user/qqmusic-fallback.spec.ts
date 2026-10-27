import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn(), legacy: vi.fn() }));
vi.mock("../../../electron/main/apis/qqmusic/core/request", () => ({
  qmRequest: mocks.request,
  getQQMusicCookies: () => ({ qm_keyst: "test", euin: "test" }),
  getQQMusicUin: () => "1",
}));
vi.mock("../../../electron/main/apis/qqmusic/modules/song_list", () => ({ default: mocks.legacy }));
const accountModule = "../../../electron/main/apis/qqmusic/modules/account";
const { account } = await import(accountModule);

it("CgiGetDiss 返回 10000 时用实际喜欢歌单 ID 读取网页接口", async () => {
  mocks.request.mockImplementation(async (_module, method) =>
    method === "GetPlaylistByUin"
      ? { v_playlist: [{ tid: 999, dirId: 201, dirName: "喜欢" }] }
      : { code: 10000, subcode: 0, songlist: [] },
  );
  mocks.legacy.mockResolvedValue({
    code: 200,
    id: "999",
    name: "喜欢",
    total: 2,
    songs: [
      { id: "10", mid: "first", name: "one", duration: 1000 },
      { id: "20", mid: "second", name: "two", duration: 2000 },
    ],
  });
  const result = await account({ action: "detail", liked: true, id: "0", offset: 1 });
  expect(mocks.legacy).toHaveBeenCalledWith({ id: "999" });
  expect(result).toMatchObject({
    total: 2,
    hasMore: false,
    songs: [{ id: 20, mid: "second", interval: 2 }],
  });
});

it("网页接口缺歌时显式失败，不伪装成功", async () => {
  mocks.request.mockResolvedValue({ code: 10000, subcode: 0 });
  mocks.legacy.mockResolvedValue({ code: 200, total: 5, songs: [] });
  await expect(account({ action: "detail", id: "999" })).rejects.toThrow("不完整");
});
