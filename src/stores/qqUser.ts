import { fetchQQMusicLoginStatus, logoutQQMusic } from "@/apis/login/qqmusic";
import { fetchQQAccountPlaylist, qqAccount } from "@/apis/user/qqmusic";
import type { QQPlaylist } from "@shared/types/qqmusic-account";
import type { PlatformProfile } from "@shared/types/platform";
import type { Album, Artist, Track } from "@shared/types/player";

export const useQQUserStore = defineStore("qq-user", () => {
  const profile = ref<PlatformProfile | null>(null);
  const createdPlaylists = shallowRef<QQPlaylist[]>([]);
  const subscribedPlaylists = shallowRef<QQPlaylist[]>([]);
  const playlists = computed(() => [...createdPlaylists.value, ...subscribedPlaylists.value]);
  const likedPlaylistId = computed(
    () => createdPlaylists.value.find((p) => p.dirId === 201)?.id ?? null,
  );
  const likedPlaylistTracks = shallowRef<Track[]>([]);
  const likedSongIds = shallowRef(new Set<string>());
  const likedPlaylistLoading = ref(false);
  const contentError = ref("");
  const isLoggedIn = computed(() => profile.value !== null);
  const subcount = computed(() => ({
    createdPlaylistCount: createdPlaylists.value.length,
    subPlaylistCount: subscribedPlaylists.value.length,
    artistCount: 0,
  }));
  const albums = shallowRef<Album[]>([]);
  const artists = shallowRef<Artist[]>([]);
  const level = computed(() => profile.value?.level);
  let generation = 0;
  let statusRequest = 0;
  let likedAbort: AbortController | undefined;
  let likedLoaded = false;
  const pendingLikes = new Set<string>();

  const clearContent = (): void => {
    generation++;
    likedAbort?.abort();
    createdPlaylists.value = [];
    subscribedPlaylists.value = [];
    likedPlaylistTracks.value = [];
    likedSongIds.value = new Set();
    likedPlaylistLoading.value = false;
    likedLoaded = false;
    contentError.value = "";
    pendingLikes.clear();
  };
  const invalidateSession = (): void => {
    statusRequest++;
    profile.value = null;
    clearContent();
  };
  const refreshPlaylists = async (): Promise<void> => {
    if (!profile.value) return;
    const epoch = generation;
    const list = await qqAccount<QQPlaylist[]>("created");
    if (epoch !== generation) return;
    createdPlaylists.value = [
      ...list.filter((p) => p.dirId === 201),
      ...list.filter((p) => p.dirId !== 201),
    ];
  };
  const ensureLikedPlaylist = async (force = false): Promise<void> => {
    if (
      !profile.value ||
      pendingLikes.size > 0 ||
      (!force && (likedLoaded || likedPlaylistLoading.value))
    )
      return;
    likedAbort?.abort();
    const abort = new AbortController();
    likedAbort = abort;
    const epoch = generation;
    likedPlaylistLoading.value = true;
    try {
      const result = await fetchQQAccountPlaylist(likedPlaylistId.value ?? "0", {
        liked: true,
        signal: abort.signal,
      });
      if (epoch !== generation || abort.signal.aborted) return;
      likedPlaylistTracks.value = result.tracks;
      likedSongIds.value = new Set(result.tracks.map((t) => t.id));
      likedLoaded = true;
    } catch (err) {
      if (!abort.signal.aborted && epoch === generation)
        contentError.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (!abort.signal.aborted && epoch === generation) likedPlaylistLoading.value = false;
    }
  };
  const loadContent = async (): Promise<void> => {
    const epoch = generation;
    contentError.value = "";
    const results = await Promise.allSettled([
      refreshPlaylists(),
      ensureLikedPlaylist(true),
      (async () => {
        const list: QQPlaylist[] = [];
        let offset = 0;
        while (epoch === generation) {
          const page = await qqAccount<{ playlists: QQPlaylist[]; hasMore: boolean }>("favorites", {
            offset,
          });
          list.push(...page.playlists);
          if (!page.hasMore) break;
          if (!page.playlists.length) throw new Error("QQ 音乐收藏歌单分页不完整");
          offset += page.playlists.length;
        }
        if (epoch === generation) subscribedPlaylists.value = list;
      })(),
    ]);
    if (epoch !== generation) return;
    for (const result of results)
      if (result.status === "rejected") contentError.value = String(result.reason);
  };
  /** 同步设置页中的账号切换，同时使旧异步请求失效。 */
  const applyProfile = (latest: PlatformProfile | null): void => {
    statusRequest++;
    if (!latest) {
      invalidateSession();
      return;
    }
    if (profile.value?.userId !== latest.userId) clearContent();
    profile.value = latest;
    void loadContent();
  };
  const fetchStatus = async (): Promise<boolean> => {
    const request = ++statusRequest;
    const latest = await fetchQQMusicLoginStatus();
    if (request !== statusRequest) return isLoggedIn.value;
    applyProfile(latest);
    return latest !== null;
  };
  const logout = async (): Promise<void> => {
    invalidateSession();
    await logoutQQMusic();
  };
  const isLiked = (id: string): boolean => likedSongIds.value.has(id);
  const toggleLike = async (id: string): Promise<boolean> => {
    if (!profile.value || pendingLikes.has(id)) return false;
    pendingLikes.add(id);
    const epoch = generation;
    const add = !isLiked(id);
    // 中止旧读取，防止写入成功后被旧歌单覆盖。
    likedAbort?.abort();
    likedPlaylistLoading.value = false;
    try {
      await qqAccount("tracks", { mids: [id], add, liked: true });
      if (epoch !== generation) return false;
      const ids = new Set(likedSongIds.value);
      if (add) ids.add(id);
      else ids.delete(id);
      likedSongIds.value = ids;
      if (!add) likedPlaylistTracks.value = likedPlaylistTracks.value.filter((t) => t.id !== id);
      likedLoaded = false;
      return true;
    } catch (err) {
      if (epoch === generation) contentError.value = String(err);
      return false;
    } finally {
      if (epoch === generation) {
        pendingLikes.delete(id);
        if (pendingLikes.size === 0) void ensureLikedPlaylist(true);
      }
    }
  };
  const createPlaylist = async (name: string, privacy: 0 | 10 = 0): Promise<QQPlaylist> => {
    if (privacy !== 0) throw new Error("QQ 音乐暂不支持创建私密歌单");
    const epoch = generation;
    const result = await qqAccount<QQPlaylist>("create", { name });
    if (epoch === generation)
      await refreshPlaylists().catch((err) => {
        contentError.value = String(err);
      });
    return result;
  };
  const deletePlaylist = async (id: string): Promise<void> => {
    const epoch = generation;
    await qqAccount("delete", { id });
    if (epoch === generation)
      createdPlaylists.value = createdPlaylists.value.filter((p) => p.id !== id);
  };
  const changeTracks = async (id: string, mids: string[], add: boolean): Promise<void> => {
    if (!profile.value) throw new Error("请先登录 QQ 音乐");
    const epoch = generation;
    await qqAccount("tracks", { id, mids, add });
    if (epoch !== generation) return;
    if (id === likedPlaylistId.value) await ensureLikedPlaylist(true);
    await refreshPlaylists().catch((err) => {
      contentError.value = String(err);
    });
  };
  const addTracksToPlaylist = async (id: string, mids: string[]): Promise<number> => {
    const epoch = generation;
    const current = await fetchQQAccountPlaylist(id);
    if (epoch !== generation) throw new Error("账号已切换，请重试");
    const existing = new Set(current.tracks.map((track) => track.id));
    const additions = [...new Set(mids)].filter((mid) => !existing.has(mid));
    if (!additions.length) return 0;
    await changeTracks(id, additions, true);
    return additions.length;
  };
  const removeTracksFromPlaylist = (id: string, mids: string[]): Promise<void> =>
    changeTracks(id, mids, false);
  const togglePlaylistSubscribe = async (id: string, subscribe: boolean): Promise<void> => {
    const epoch = generation;
    await qqAccount("subscribe", { id, subscribe });
    if (epoch === generation) await loadContent();
  };
  return {
    profile,
    isLoggedIn,
    playlists,
    createdPlaylists,
    subscribedPlaylists,
    likedPlaylistId,
    likedPlaylistTracks,
    likedSongIds,
    likedPlaylistLoading,
    contentError,
    subcount,
    albums,
    artists,
    level,
    applyProfile,
    fetchStatus,
    logout,
    invalidateSession,
    clearContent,
    loadContent,
    isLiked,
    /** 查询歌曲是否正在提交喜欢状态 */
    isLikePending: (id: string): boolean => pendingLikes.has(id),
    toggleLike,
    ensureLikedPlaylist,
    createPlaylist,
    deletePlaylist,
    addTracksToPlaylist,
    removeTracksFromPlaylist,
    togglePlaylistSubscribe,
  };
});
