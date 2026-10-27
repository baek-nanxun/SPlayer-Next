import type {
  QQAccountSong,
  QQPlaylist,
  QQPlaylistPage,
} from "../../../../../shared/types/qqmusic-account";

interface RawPlaylist {
  tid?: string | number;
  id?: string | number;
  dissid?: string | number;
  dirId?: number;
  dirid?: number;
  dirName?: string;
  title?: string;
  dissname?: string;
  name?: string;
  cover?: string;
  logo?: string;
  description?: string;
  song_cnt?: number;
  picUrl?: string;
  picurl?: string;
  desc?: string;
  nick?: string;
  nickname?: string;
  songNum?: number;
  songnum?: number;
  invalid?: boolean;
}

type Request = <T>(
  module: string,
  method: string,
  param: Record<string, unknown>,
  options?: { retry?: boolean },
) => Promise<T>;
interface Session {
  uin: string;
  euin: string;
}

/** 将账号内目录和公开歌单信息规范化。 */
const playlist = (raw: RawPlaylist): QQPlaylist => ({
  id: String(raw.tid ?? raw.id ?? raw.dissid ?? 0),
  dirId: Number(raw.dirId ?? raw.dirid ?? 0),
  name: raw.dirName ?? raw.title ?? raw.dissname ?? raw.name ?? "",
  cover: raw.picUrl ?? raw.picurl ?? raw.cover ?? raw.logo,
  description: raw.desc ?? raw.description,
  owner: raw.nick ?? raw.nickname,
  trackCount: raw.songNum ?? raw.songnum ?? raw.song_cnt ?? 0,
});

/** 校验上游数字 ID，拒绝把歌曲 MID 或不安全的整数发给写接口。 */
const numericId = (value: unknown, allowZero = false): number => {
  if (!/^\d+$/.test(String(value))) throw new Error("QQ 音乐 ID 无效");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < (allowZero ? 0 : 1)) throw new Error("QQ 音乐 ID 无效");
  return id;
};

/** QQ 账号歌单接口；写请求不自动重试，避免创建重复歌单。 */
export const createQQLibrary = (request: Request, session: () => Session) => {
  const getSession = (): Session => {
    const current = session();
    if (!current.uin || current.uin === "0") throw new Error("请先登录 QQ 音乐");
    return current;
  };
  const encryptedUin = (): string => {
    const { euin } = getSession();
    if (!euin) throw new Error("QQ 音乐登录信息不完整，请重新扫码登录");
    return euin;
  };
  const created = async (): Promise<QQPlaylist[]> => {
    const data = await request<{ v_playlist?: RawPlaylist[]; bFinish?: boolean }>(
      "music.musicasset.PlaylistBaseRead",
      "GetPlaylistByUin",
      { uin: getSession().uin },
    );
    if (!Array.isArray(data?.v_playlist) || data.bFinish === false)
      throw new Error("QQ 音乐个人歌单列表不完整");
    return data.v_playlist
      .filter((p) => !p.invalid)
      .map(playlist)
      .filter((p) => p.id !== "0" && p.dirId > 0);
  };
  const owned = async (id: unknown): Promise<QQPlaylist> => {
    const found = (await created()).find((p) => p.id === String(id));
    if (!found) throw new Error("只能修改当前 QQ 音乐账号创建的歌单");
    return found;
  };
  return {
    created,
    favorites: async (offset = 0) => {
      const data = await request<{ v_list?: RawPlaylist[]; hasmore?: number }>(
        "music.musicasset.PlaylistFavRead",
        "CgiGetPlaylistFavInfo",
        { uin: encryptedUin(), offset, size: 100 },
      );
      if (!Array.isArray(data?.v_list)) throw new Error("QQ 音乐收藏歌单响应无效");
      return { playlists: data.v_list.map(playlist), hasMore: !!data.hasmore };
    },
    detail: async (id: unknown, offset = 0, liked = false): Promise<QQPlaylistPage> => {
      const param = liked
        ? { disstid: 0, dirid: 201, enc_host_uin: encryptedUin() }
        : { disstid: numericId(id), dirid: 0 };
      const data = await request<{
        code?: number;
        subcode?: number;
        dirinfo?: RawPlaylist;
        songlist?: QQAccountSong[];
        total_song_num?: number;
        hasmore?: number;
      }>("music.srfDissInfo.DissInfo", "CgiGetDiss", {
        ...param,
        song_begin: offset,
        song_num: 100,
        tag: true,
        userinfo: true,
        orderlist: true,
      });
      if (
        !data ||
        (data.code ?? 0) !== 0 ||
        (data.subcode ?? 0) !== 0 ||
        !Array.isArray(data.songlist)
      )
        throw new Error(`QQ 音乐歌单读取失败 (code=${data?.code}, subcode=${data?.subcode})`);
      return {
        playlist: data.dirinfo ? playlist(data.dirinfo) : undefined,
        songs: data.songlist,
        total: data.total_song_num ?? data.songlist.length,
        hasMore: !!data.hasmore,
      };
    },
    create: async (name: unknown): Promise<QQPlaylist> => {
      getSession();
      if (typeof name !== "string" || !name.trim()) throw new Error("歌单名称不能为空");
      const data = await request<{ retCode?: number; result?: RawPlaylist }>(
        "music.musicasset.PlaylistBaseWrite",
        "AddPlaylist",
        { dirName: name.trim() },
        { retry: false },
      );
      if (data?.retCode !== 0 || !data.result?.tid || !data.result.dirId)
        throw new Error("QQ 音乐创建歌单失败，请刷新列表后重试");
      return playlist(data.result);
    },
    delete: async (id: unknown): Promise<void> => {
      const owner = getSession().uin;
      const target = await owned(id);
      if (target.dirId === 201) throw new Error("不能删除我喜欢的音乐");
      if (getSession().uin !== owner) throw new Error("账号已切换，请重试");
      const data = await request<{ retCode?: number; result?: { dirId?: number } }>(
        "music.musicasset.PlaylistBaseWrite",
        "DelPlaylist",
        { dirId: target.dirId },
        { retry: false },
      );
      if (data?.retCode !== 0 || data.result?.dirId !== target.dirId)
        throw new Error("QQ 音乐删除歌单失败");
    },
    tracks: async (id: unknown, mids: unknown, add: boolean, liked = false): Promise<void> => {
      const owner = getSession().uin;
      if (
        !Array.isArray(mids) ||
        !mids.length ||
        mids.length > 500 ||
        mids.some((mid) => typeof mid !== "string" || !/^[a-zA-Z0-9]+$/.test(mid))
      )
        throw new Error("QQ 音乐曲目参数无效（每批最多 500 首）");
      const target = liked ? { dirId: 201, id: "0" } : await owned(id);
      // 播放器使用 MID，写接口要求数字 songId 和真实 songType。
      const songs: Array<{ songId: number; songType: number }> = [];
      for (const mid of new Set<string>(mids)) {
        const data = await request<{ track_info?: { id: number; mid: string; type?: number } }>(
          "music.pf_song_detail_svr",
          "get_song_detail_yqq",
          { song_type: 0, song_mid: mid },
        );
        const song = data?.track_info;
        if (!song || song.mid !== mid || !Number.isInteger(song.type))
          throw new Error("QQ 音乐歌曲信息不完整，未提交修改");
        songs.push({ songId: numericId(song.id), songType: song.type! });
      }
      if (getSession().uin !== owner) throw new Error("账号已切换，请重试");
      const data = await request<{ retCode?: number }>(
        "music.musicasset.PlaylistDetailWrite",
        add ? "AddSonglist" : "DelSonglist",
        { dirId: target.dirId, tid: numericId(target.id, true), bFmtUtf8: true, v_songInfo: songs },
        { retry: false },
      );
      if (data?.retCode !== 0) throw new Error("QQ 音乐修改歌曲失败，请刷新歌单确认状态");
    },
    subscribe: async (id: unknown, subscribe: boolean): Promise<void> => {
      const tid = numericId(id);
      const data = await request<{ result?: number; v_failedPlaylistId?: number[] }>(
        "music.musicasset.PlaylistFavWrite",
        subscribe ? "FavPlaylist" : "CancelFavPlaylist",
        { uin: encryptedUin(), v_playlistId: [tid] },
        { retry: false },
      );
      if (data?.result !== 0 || data.v_failedPlaylistId?.includes(tid))
        throw new Error("QQ 音乐收藏歌单失败");
    },
  };
};
