/** 官方协议字段参考 Viemean/qmtui，MIT 授权说明见 THIRD_PARTY_NOTICES/qmtui-LICENSE.txt */
import type { QMRequestOptions } from "./request";
import type {
  QQTogetherHeartbeat,
  QQTogetherSong,
  QQTogetherTrackInfo,
} from "../../../../../shared/types/qqmusic-together";

export type QQTogetherRequest = <T>(
  module: string,
  method: string,
  param: Record<string, unknown>,
  options: QMRequestOptions,
) => Promise<T>;
const roomService = "music.lightUGCRoom.LightUGCRoomSvr";
const songService = "music.lightUGCRoom.LightUGCRoomSongSvr";
const requestOptions: QMRequestOptions = {
  retry: false,
  session: false,
  autoRefresh: false,
  appGateway: true,
};

/** 仅接受官方域名下的一起听页面，短链在主进程单独展开
 * @param text - 完整链接或包含链接的分享文案
 */
export const parseQQTogetherInvite = (
  text: string,
): { showID: string; fromEncryptedUin: string; songId?: number; url: string } => {
  const found = text.match(/https:\/\/[^\s<>"，。)]+/);
  const url = new URL(found?.[0] || text.trim());
  if (
    url.protocol !== "https:" ||
    !["i.y.qq.com", "y.qq.com", "i2.y.qq.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/n2/m/share/listen_together/index.html"
  )
    throw new Error("请粘贴 QQ 音乐官方一起听分享链接");
  const showID = validRoomId(url.searchParams.get("showid"));
  const fromEncryptedUin =
    url.searchParams.get("share_encrypt_uin") || url.searchParams.get("hosteuin") || "";
  if (fromEncryptedUin.length > 256 || [...fromEncryptedUin].some((c) => c.charCodeAt(0) <= 32))
    throw new Error("QQ 音乐邀请者信息无效");
  const songId = url.searchParams.get("songid");
  return {
    showID,
    fromEncryptedUin,
    songId: songId ? integer(songId, "歌曲 ID", 1) : undefined,
    url: url.href,
  };
};

/** 校验官方房间标识
 * @param value - LUGC 房间号
 */
const validRoomId = (value: unknown): string => {
  if (typeof value !== "string" || !/^LUGC[a-zA-Z0-9]{1,120}$/.test(value))
    throw new Error("QQ 音乐房间号无效");
  return value;
};

/** 校验整数参数，拒绝无效进度被隐式替换为零
 * @param value - 数值或数字文本
 * @param name - 错误提示字段
 * @param min - 最小值
 */
const integer = (value: unknown, name: string, min = 0): number => {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    value === "" ||
    !/^\d+$/.test(String(value))
  )
    throw new Error(`QQ 音乐${name}无效`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`QQ 音乐${name}无效`);
  return n;
};

/** 严格校验官方数字歌曲列表，不猜测 MID 对应的歌曲
 * @param value - 官方歌曲列表
 */
const songs = (value: unknown): QQTogetherSong[] => {
  if (!Array.isArray(value) || !value.length || value.length > 1000)
    throw new Error("QQ 官方一起听队列需包含 1–1000 首歌曲");
  return value.map((raw, index) => {
    const song = raw as Partial<QQTogetherSong> | null;
    if (!song || typeof song.title !== "string" || song.title.length > 200)
      throw new Error("QQ 音乐歌曲资料无效");
    return {
      songID: integer(song.songID, "歌曲 ID", 1),
      songType: integer(song.songType, "歌曲类型"),
      songIndex: index,
      title: song.title,
    };
  });
};

/** 实验协议入口，登录态与网关沿用应用请求层，所有操作禁止自动重试
 * @param request - QQ 平台请求函数
 * @param session - 当前音乐账号身份
 */
export const createQQTogetherApi = (
  request: QQTogetherRequest,
  session: () => { uin: string; musicKey: string },
) => {
  /** 固定操作开始时的账号，不允许响应跨账号使用 */
  const identity = (): string => {
    const value = session();
    if (!/^[1-9]\d*$/.test(value.uin) || !value.musicKey) throw new Error("请先登录 QQ 音乐账号");
    return `${value.uin}:${value.musicKey}`;
  };
  /** 单次请求后校验会话未变更
   * @param method - 已核实的官方方法
   * @param param - 已校验的官方参数
   * @param service - 官方服务
   */
  const call = async <T>(
    method: string,
    param: Record<string, unknown>,
    service = roomService,
  ): Promise<T> => {
    const started = identity();
    const result = await request<T>(service, method, param, requestOptions);
    if (started !== identity()) throw new Error("QQ 音乐账号已变更，请重新连接房间");
    return result;
  };
  return {
    /** 批量解析官方数字 ID，保留真实 MID、类型和时长
     * @param ids - QQ 歌曲数字 ID
     */
    tracks: async (ids: number[]): Promise<QQTogetherTrackInfo[]> => {
      if (!ids.length || ids.length > 100) throw new Error("QQ 歌曲详情每次需 1–100 首");
      const cleaned = ids.map((id) => integer(id, "歌曲 ID", 1));
      const result = await call<{ tracks?: QQTogetherTrackInfo[] }>(
        "CgiGetTrackInfo",
        { ids: cleaned, types: cleaned.map(() => 0) },
        "music.trackInfo.UniformRuleCtrl",
      );
      if (!Array.isArray(result?.tracks)) throw new Error("QQ 音乐未返回歌曲详情");
      return result.tracks;
    },
    /** 仅在缺少数字 ID 时解析真实歌曲 MID
     * @param mid - QQ 歌曲 MID
     */
    resolve: async (mid: string): Promise<QQTogetherTrackInfo> => {
      if (!/^[a-zA-Z0-9]{1,80}$/.test(mid)) throw new Error("QQ 音乐 MID 无效");
      const result = await call<{ track_info?: QQTogetherTrackInfo }>(
        "get_song_detail_yqq",
        { song_type: 0, song_mid: mid },
        "music.pf_song_detail_svr",
      );
      if (!result?.track_info?.id) throw new Error("QQ 音乐歌曲 ID 解析失败");
      return result.track_info;
    },
    /** 创建单人房间，初始状态仍需回读确认，不在创建时向他人发消息
     * @param list - 初始完整队列
     * @param index - 当前歌曲索引
     * @param position - 毫秒进度
     */
    create: async (list: unknown, index: unknown, position: unknown) => {
      const queue = songs(list);
      const at = integer(index, "歌曲索引");
      if (at >= queue.length) throw new Error("QQ 音乐歌曲索引超出队列");
      const offset = integer(position, "进度");
      const result = await call<{
        entryInfo?: { roomInfo?: { showID?: string; createUin?: string } };
      }>("LightUGCRoomCreate", {
        fromTag: 0,
        playStatus: 2,
        playMode: 0,
        songOffset: offset,
        seekTime: offset,
        sourceType: 0,
        avatarValid: 0,
        musicWorldValid: 0,
        isAITogether: 0,
        isMatchStranger: 0,
        songPlaying: queue[at],
        songInfos: queue,
      });
      validRoomId(result?.entryInfo?.roomInfo?.showID);
      return result;
    },
    /** 加入明确邀请的官方房间
     * @param showID - 房间号
     * @param fromEncryptedUin - 分享中的邀请者标识
     */
    join: (showID: unknown, fromEncryptedUin: unknown = "") => {
      if (
        typeof fromEncryptedUin !== "string" ||
        fromEncryptedUin.length > 256 ||
        [...fromEncryptedUin].some((c) => c.charCodeAt(0) <= 32)
      )
        throw new Error("QQ 音乐邀请者信息无效");
      return call<Record<string, unknown>>("LightUGCRoomEntry", {
        showID: validRoomId(showID),
        fromEncryptedUin,
        entryType: 0,
        fromTag: 0,
        avatarValid: 0,
        musicWorldValid: 0,
        songInfos: [],
      });
    },
    /** 心跳仅获取权威状态，不上报暂停或回退位置
     * @param showID - 房间号
     */
    heartbeat: async (showID: unknown): Promise<QQTogetherHeartbeat> => {
      const result = await call<QQTogetherHeartbeat>("LightUGCRoomHeartBeat", {
        showID: validRoomId(showID),
      });
      if (!result?.songInfo || !Array.isArray(result.users)) throw new Error("QQ 音乐房间状态无效");
      return result;
    },
    /** 读取完整队列，失败时不能退回单曲覆盖本机队列
     * @param showID - 房间号
     */
    playlist: async (showID: unknown): Promise<QQTogetherSong[]> => {
      const result = await call<{ songList?: unknown }>(
        "LightUGCRoomSongOper",
        { showID: validRoomId(showID), cmd: 0 },
        songService,
      );
      return songs(result?.songList);
    },
    /** 发出明确的用户播放操作
     * @param showID - 房间号
     * @param command - 1 替换队列、2 播放、3 暂停、4 切歌、7 拖动
     * @param list - 操作时的完整队列
     * @param index - 当前或目标歌曲索引
     * @param position - 毫秒进度
     */
    control: (
      showID: unknown,
      command: unknown,
      list: unknown,
      index: unknown,
      position: unknown,
    ) => {
      const cmd = integer(command, "指令");
      if (![1, 2, 3, 4, 7].includes(cmd)) throw new Error("未验证的 QQ 音乐房间指令");
      const queue = songs(list),
        at = integer(index, "歌曲索引");
      if (at >= queue.length) throw new Error("QQ 音乐歌曲索引超出队列");
      const offset = cmd === 4 ? 0 : integer(position, "进度");
      return call<Record<string, unknown>>(
        "LightUGCRoomSongOper",
        {
          showID: validRoomId(showID),
          cmd,
          sourceType: 0,
          playlistType: 0,
          songPlaying: queue[at],
          songOffset: offset,
          ...(cmd !== 4 ? { seekTime: offset } : {}),
          ...(cmd === 1 ? { songList: queue } : {}),
        },
        songService,
      );
    },
    /** 只退出当前本机音乐账号，不操作其他成员
     * @param showID - 房间号
     */
    quit: (showID: unknown) => {
      identity();
      return call<Record<string, unknown>>("LightUGCRoomQuit", {
        showID: validRoomId(showID),
        uinList: [session().uin],
        from: "player",
      });
    },
  };
};
