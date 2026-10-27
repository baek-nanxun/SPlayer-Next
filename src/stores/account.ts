import { useDataStore } from "./data";
import { useUserStore } from "./user";
import { useQQUserStore } from "./qqUser";

/** 主账号入口；网易云与 QQ 的状态和凭据各自独立。 */
export const useAccountStore = defineStore(
  "account",
  () => {
    const platform = ref<"netease" | "qqmusic">("netease");
    const netease = useUserStore();
    const qq = useQQUserStore();
    const data = useDataStore();
    watch(
      () => qq.profile,
      (profile) => data.setPlatformProfile("qqmusic", profile),
    );
    const active = computed(() => (platform.value === "qqmusic" ? qq : netease));
    const profile = computed(() =>
      platform.value === "qqmusic" && qq.profile
        ? { ...qq.profile, vipType: qq.profile.isVip ? 1 : 0, signature: undefined }
        : platform.value === "netease"
          ? netease.profile
          : null,
    );
    const contentError = computed(() => (platform.value === "qqmusic" ? qq.contentError : ""));
    const accounts = computed(() => [
      { platform: "netease" as const, profile: netease.profile, isLoggedIn: netease.isLoggedIn },
      { platform: "qqmusic" as const, profile: qq.profile, isLoggedIn: qq.isLoggedIn },
    ]);
    /** 两个平台分别恢复，单个平台失败不阻断另一个。 */
    const restoreAccounts = async (): Promise<void> => {
      await Promise.allSettled([netease.fetchStatus(), qq.fetchStatus()]);
    };
    let selection = 0;
    /** 校验目标账号并切换当前平台 */
    const selectPlatform = async (next: "netease" | "qqmusic"): Promise<boolean> => {
      const request = ++selection;
      const ok = await (next === "qqmusic" ? qq.fetchStatus() : netease.fetchStatus());
      if (request !== selection) return false;
      if (ok) platform.value = next;
      return ok;
    };
    /** 退出当前平台，不清除另一平台的账号和内容。 */
    const logout = async (): Promise<void> => {
      const current = platform.value;
      const request = ++selection;
      await active.value.logout();
      const other = current === "qqmusic" ? "netease" : "qqmusic";
      if (
        request === selection &&
        platform.value === current &&
        accounts.value.find((a) => a.platform === other)?.isLoggedIn
      )
        platform.value = other;
    };
    const updatePlaylist = (
      id: string,
      data: { name?: string; description?: string },
    ): Promise<void> => {
      if (platform.value !== "netease")
        return Promise.reject(new Error("QQ 音乐暂不支持修改歌单信息"));
      return netease.updatePlaylist(id, data);
    };
    const toggleAlbumSubscribe = (id: string, subscribe: boolean): Promise<void> => {
      if (platform.value !== "netease") return Promise.reject(new Error("QQ 音乐暂不支持收藏专辑"));
      return netease.toggleAlbumSubscribe(id, subscribe);
    };
    return {
      platform,
      accounts,
      restoreAccounts,
      profile,
      contentError,
      qqProfile: computed(() => qq.profile),
      selectPlatform,
      updatePlaylist,
      toggleAlbumSubscribe,
      isLoggedIn: computed(() => active.value.isLoggedIn),
      playlists: computed(() => active.value.playlists),
      createdPlaylists: computed(() => active.value.createdPlaylists),
      subscribedPlaylists: computed(() => active.value.subscribedPlaylists),
      likedPlaylistId: computed(() => active.value.likedPlaylistId),
      likedPlaylistTracks: computed(() => active.value.likedPlaylistTracks),
      likedSongIds: computed(() => active.value.likedSongIds),
      likedPlaylistLoading: computed(() => active.value.likedPlaylistLoading),
      subcount: computed(() => active.value.subcount),
      albums: computed(() => active.value.albums),
      artists: computed(() => active.value.artists),
      level: computed(() => active.value.level),
      fetchStatus: (...args: Parameters<typeof netease.fetchStatus>) =>
        active.value.fetchStatus(...args),
      logout,
      clearContent: (...args: Parameters<typeof netease.clearContent>) =>
        active.value.clearContent(...args),
      isLikePending: (id: string) => active.value.isLikePending(id),
      isLiked: (...args: Parameters<typeof netease.isLiked>) => active.value.isLiked(...args),
      toggleLike: (...args: Parameters<typeof netease.toggleLike>) =>
        active.value.toggleLike(...args),
      ensureLikedPlaylist: (...args: Parameters<typeof netease.ensureLikedPlaylist>) =>
        active.value.ensureLikedPlaylist(...args),
      createPlaylist: (...args: Parameters<typeof netease.createPlaylist>) =>
        active.value.createPlaylist(...args),
      deletePlaylist: (...args: Parameters<typeof netease.deletePlaylist>) =>
        active.value.deletePlaylist(...args),
      addTracksToPlaylist: (...args: Parameters<typeof netease.addTracksToPlaylist>) =>
        active.value.addTracksToPlaylist(...args),
      removeTracksFromPlaylist: (...args: Parameters<typeof netease.removeTracksFromPlaylist>) =>
        active.value.removeTracksFromPlaylist(...args),
      togglePlaylistSubscribe: (...args: Parameters<typeof netease.togglePlaylistSubscribe>) =>
        active.value.togglePlaylistSubscribe(...args),
    };
  },
  { persist: { pick: ["platform"] } },
);
