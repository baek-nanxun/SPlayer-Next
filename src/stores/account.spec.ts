import { createPinia, setActivePinia } from "pinia";
import { reactive } from "vue";
import { beforeEach, expect, it, vi } from "vitest";
const stores = vi.hoisted(() => ({
  netease: {} as Record<string, unknown>,
  qq: {} as Record<string, unknown>,
  setProfile: vi.fn(),
}));
vi.mock("./user", () => ({ useUserStore: () => stores.netease }));
vi.mock("./qqUser", () => ({ useQQUserStore: () => stores.qq }));
vi.mock("./data", () => ({ useDataStore: () => ({ setPlatformProfile: stores.setProfile }) }));
import { useAccountStore } from "./account";

beforeEach(() => {
  setActivePinia(createPinia());
  for (const key of ["netease", "qq"] as const) {
    stores[key] = reactive({
      profile: { userId: key, nickname: key },
      isLoggedIn: true,
      fetchStatus: vi.fn().mockResolvedValue(true),
      toggleLike: vi.fn().mockResolvedValue(true),
      addTracksToPlaylist: vi.fn().mockResolvedValue(1),
      createdPlaylists: [{ id: "same-id", name: key }],
      playlists: [],
      isLikePending: vi.fn().mockReturnValue(key === "qq"),
      isLiked: vi.fn().mockReturnValue(key === "qq"),
    });
  }
});

it("QQ 登录后红心和歌单写入只调用 QQ 后端", async () => {
  const account = useAccountStore();
  expect(await account.selectPlatform("qqmusic")).toBe(true);
  await account.toggleLike("mid");
  await account.addTracksToPlaylist("same-id", ["mid"]);
  expect(stores.qq.toggleLike).toHaveBeenCalledWith("mid");
  expect(stores.netease.toggleLike).not.toHaveBeenCalled();
  expect(stores.netease.addTracksToPlaylist).not.toHaveBeenCalled();
  expect(account.createdPlaylists[0].name).toBe("qq");
});

it("同名 ID 的平台状态隔离，切回网易云只读取网易云红心", async () => {
  const account = useAccountStore();
  await account.selectPlatform("qqmusic");
  expect(account.isLiked("same-id")).toBe(true);
  await account.selectPlatform("netease");
  expect(account.isLiked("same-id")).toBe(false);
  expect(account.createdPlaylists[0].name).toBe("netease");
});

it("新平台登录失败时保留当前主账号", async () => {
  const account = useAccountStore();
  vi.mocked(stores.qq.fetchStatus as () => Promise<boolean>).mockResolvedValue(false);
  expect(await account.selectPlatform("qqmusic")).toBe(false);
  expect(account.platform).toBe("netease");
});

it("同时恢复两个平台，QQ 失败不影响网易云登录", async () => {
  vi.mocked(stores.qq.fetchStatus as () => Promise<boolean>).mockRejectedValue(
    new Error("offline"),
  );
  const account = useAccountStore();
  await account.restoreAccounts();
  expect(stores.netease.fetchStatus).toHaveBeenCalledOnce();
  expect(stores.qq.fetchStatus).toHaveBeenCalledOnce();
  expect(account.accounts.map((a) => a.platform)).toEqual(["netease", "qqmusic"]);
  expect(account.platform).toBe("netease");
});

it("退出 QQ 后网易云仍登录，保留歌单并切回网易云", async () => {
  stores.qq.logout = vi.fn(async () => {
    stores.qq.isLoggedIn = false;
    stores.qq.profile = null;
  });
  stores.netease.logout = vi.fn();
  const account = useAccountStore();
  await account.selectPlatform("qqmusic");
  await account.logout();
  expect(stores.qq.logout).toHaveBeenCalledOnce();
  expect(stores.netease.logout).not.toHaveBeenCalled();
  expect(account.platform).toBe("netease");
  expect(account.createdPlaylists[0].name).toBe("netease");
  expect(account.accounts.find((a) => a.platform === "netease")?.isLoggedIn).toBe(true);
});

it("较早的切换请求迟到时不能覆盖最新选择", async () => {
  let resolve!: (value: boolean) => void;
  vi.mocked(stores.qq.fetchStatus as () => Promise<boolean>).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const account = useAccountStore();
  const pending = account.selectPlatform("qqmusic");
  await account.selectPlatform("netease");
  resolve(true);
  expect(await pending).toBe(false);
  expect(account.platform).toBe("netease");
});

it("新版红心防重复提交状态按当前平台查询", async () => {
  const account = useAccountStore();
  await account.selectPlatform("qqmusic");
  expect(account.isLikePending("mid")).toBe(true);
  expect(stores.qq.isLikePending).toHaveBeenCalledWith("mid");
  expect(stores.netease.isLikePending).not.toHaveBeenCalled();
});
