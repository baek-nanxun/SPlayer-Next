import { beforeEach, describe, expect, it, vi } from "vitest";

const { account, search } = vi.hoisted(() => ({ account: vi.fn(), search: vi.fn() }));

vi.mock("./modules", () => ({ modules: { account, search } }));
vi.mock("./core/request", () => ({
  clearQQMusicCookies: vi.fn(),
  mergeQQMusicCookies: vi.fn(),
}));

import { callQQMusic, clearQQMusicCache } from "./index";

describe("QQ 音乐账号接口缓存隔离", () => {
  beforeEach(() => {
    clearQQMusicCache();
    account.mockReset();
    search.mockReset();
  });

  it("收藏、取消再收藏会发送三次真实写请求", async () => {
    account.mockResolvedValue({ success: true });
    const params = { action: "subscribe", id: "test-playlist", subscribe: true };

    await callQQMusic("account", params);
    await callQQMusic("account", { ...params, subscribe: false });
    await callQQMusic("account", params);

    expect(account.mock.calls.map(([p]) => p.subscribe)).toEqual([true, false, true]);
  });

  it("写操作之后重新读取歌单会得到服务器的新状态", async () => {
    account
      .mockResolvedValueOnce({ playlists: [] })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ playlists: [{ id: "new-playlist" }] });

    await expect(callQQMusic("account", { action: "created" })).resolves.toEqual({
      playlists: [],
    });
    await callQQMusic("account", { action: "create", name: "新歌单" });
    await expect(callQQMusic("account", { action: "created" })).resolves.toEqual({
      playlists: [{ id: "new-playlist" }],
    });
  });

  it("普通搜索仍复用有界响应缓存", async () => {
    search.mockResolvedValue({ songs: ["test-song"] });
    await callQQMusic("search", { keyword: "test-song" });
    await callQQMusic("search", { keyword: "test-song" });
    expect(search).toHaveBeenCalledOnce();
  });
});
