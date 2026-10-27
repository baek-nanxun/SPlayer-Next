import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { effectScope, reactive } from "vue";
const mocks = vi.hoisted(() => ({
  account: {} as Record<string, unknown>,
  recommend: vi.fn(),
  daily: vi.fn(),
}));
vi.mock("@/stores/account", () => ({ useAccountStore: () => mocks.account }));
vi.mock("@/stores/data", () => ({ useDataStore: () => ({ ensureDailyRecommend: mocks.daily }) }));
vi.mock("@/core/player", () => ({}));
vi.mock("@/composables/useToast", () => ({ toast: {} }));
vi.mock("@/apis/recommend/netease", () => ({
  fetchRecommendPlaylists: mocks.recommend,
  fetchRadarPlaylists: async () => [],
  fetchArtists: async () => [],
  fetchNewAlbums: async () => [],
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
import { useHomeDiscover } from "./useHomeDiscover";
import { useDailyRecommend } from "./useDailyRecommend";
let scope = effectScope();
beforeEach(() => {
  scope = effectScope();
  vi.stubGlobal("useI18n", () => ({ t: (key: string) => key }));
  mocks.account = reactive({
    platform: "netease",
    profile: { userId: Math.random().toString() },
    isLoggedIn: true,
    playlists: [],
    likedPlaylistId: "liked",
    likedPlaylistTracks: [],
  });
  mocks.recommend.mockReset();
  mocks.daily.mockReset();
});
afterEach(() => {
  scope.stop();
  vi.unstubAllGlobals();
});

it("切换 QQ 后迟到的网易云推荐不能覆盖 QQ 歌单，收藏名称保留", async () => {
  let resolve!: (value: unknown[]) => void;
  mocks.recommend.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const home = scope.run(() => useHomeDiscover())!;
  const pending = home.load();
  mocks.account.platform = "qqmusic";
  mocks.account.playlists = [{ id: "123", name: "收藏的歌单", trackCount: 152 }];
  resolve([{ id: "netease-only", title: "旧账号歌单" }]);
  await pending;
  expect(home.recommendPlaylists.value.map((p) => p.title)).toEqual(["收藏的歌单"]);
  expect(home.artists.value).toEqual([]);
});

it("QQ 首页从 QQ 喜欢曲目生成内容，不请求网易云每日推荐", async () => {
  mocks.account.platform = "qqmusic";
  mocks.account.likedPlaylistTracks = [{ id: "qqmid", title: "QQ 歌曲", source: "qqmusic" }];
  const home = scope.run(() => useDailyRecommend())!;
  await home.load();
  expect(home.previewTracks.value.map((t) => t.id)).toEqual(["qqmid"]);
  expect(mocks.daily).not.toHaveBeenCalled();
});
