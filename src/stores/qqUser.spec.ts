import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
const api = vi.hoisted(() => ({
  status: vi.fn(),
  logout: vi.fn(),
  account: vi.fn(),
  playlist: vi.fn(),
}));
vi.mock("@/apis/login/qqmusic", () => ({
  fetchQQMusicLoginStatus: api.status,
  logoutQQMusic: api.logout,
}));
vi.mock("@/apis/user/qqmusic", () => ({
  qqAccount: api.account,
  fetchQQAccountPlaylist: api.playlist,
}));
import { useQQUserStore } from "./qqUser";

const track = { id: "mid", source: "qqmusic" as const, title: "song", duration: 1000 };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("QQ 主账号状态", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    Object.values(api).forEach((fn) => fn.mockReset());
    api.status.mockResolvedValue({ userId: "100", nickname: "QQ" });
    api.account.mockImplementation(async (action) => {
      if (action === "created") return [{ id: "123", dirId: 201, name: "喜欢", trackCount: 0 }];
      if (action === "favorites") return { playlists: [], hasMore: false };
      return { success: true };
    });
    api.playlist.mockResolvedValue({ tracks: [] });
    api.logout.mockResolvedValue(undefined);
  });

  it("账号切换后丢弃旧账号的延迟歌单响应", async () => {
    const old = deferred<{ tracks: (typeof track)[] }>();
    api.playlist.mockReturnValueOnce(old.promise);
    const user = useQQUserStore();
    await user.fetchStatus();
    api.status.mockResolvedValue({ userId: "200", nickname: "new" });
    await user.fetchStatus();
    await flushPromises();
    old.resolve({ tracks: [track] });
    await flushPromises();
    expect(user.profile?.userId).toBe("200");
    expect(user.likedPlaylistTracks).toEqual([]);
    expect(user.isLiked("mid")).toBe(false);
  });

  it("失败的喜欢写请求不显示成功红心", async () => {
    const user = useQQUserStore();
    await user.fetchStatus();
    await flushPromises();
    api.account.mockRejectedValueOnce(new Error("denied"));
    expect(await user.toggleLike("mid")).toBe(false);
    expect(user.isLiked("mid")).toBe(false);
  });

  it("快速双击只发出一次喜欢请求", async () => {
    const user = useQQUserStore();
    await user.fetchStatus();
    await flushPromises();
    const write = deferred<unknown>();
    api.account.mockReturnValueOnce(write.promise);
    const first = user.toggleLike("mid");
    expect(await user.toggleLike("mid")).toBe(false);
    api.playlist.mockResolvedValue({ tracks: [track] });
    write.resolve({ success: true });
    expect(await first).toBe(true);
    await flushPromises();
    expect(api.account.mock.calls.filter(([action]) => action === "tracks")).toHaveLength(1);
    expect(user.isLiked("mid")).toBe(true);
  });

  it("退出后旧写入结果不恢复红心或资料", async () => {
    const user = useQQUserStore();
    await user.fetchStatus();
    await flushPromises();
    const write = deferred<unknown>();
    api.account.mockReturnValueOnce(write.promise);
    const first = user.toggleLike("mid");
    await user.logout();
    write.resolve({ success: true });
    expect(await first).toBe(false);
    expect(user.isLoggedIn).toBe(false);
    expect(user.likedSongIds.size).toBe(0);
  });

  it("网络校验失败保留当前账号", async () => {
    const user = useQQUserStore();
    await user.fetchStatus();
    await flushPromises();
    api.status.mockRejectedValue(new Error("offline"));
    await expect(user.fetchStatus()).rejects.toThrow("offline");
    expect(user.profile?.userId).toBe("100");
  });
});
