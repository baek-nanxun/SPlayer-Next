import { createOption, type Query } from "../core/option";
import { cookieToJson } from "../core/cookie";
import type { NeteaseModule, RequestFn } from "../core/types";

/** 校验官方房间或用户标识，避免向接口发送空值
 * @param query - 接口参数
 * @param key - 标识字段
 */
const identifier = (query: Query, key: string): string => {
  const value = String(query[key] ?? "");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error(`网易云一起听 ${key} 无效`);
  return value;
};

/** 校验非负整数，不将无效进度默认为开头
 * @param query - 接口参数
 * @param key - 数值字段
 */
const integer = (query: Query, key: string): number => {
  const raw = query[key];
  if (raw === undefined || raw === null || raw === "") throw new Error(`网易云一起听 ${key} 无效`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`网易云一起听 ${key} 无效`);
  return value;
};

/** 校验官方播放状态
 * @param query - 接口参数
 */
const playStatus = (query: Query): string => {
  if (query.playStatus !== "PLAY" && query.playStatus !== "PAUSE")
    throw new Error("网易云一起听播放状态无效");
  return query.playStatus;
};

/** 校验网易云曲目列表，保留完整顺序且禁止混入 QQ 音乐标识
 * @param value - 数字歌曲 ID 数组或逗号分隔字符串
 */
const songIds = (value: unknown): string[] => {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  if (!items.length || items.length > 2000) throw new Error("网易云一起听歌单需包含 1–2000 首歌");
  return items.map((item) => {
    const id = String(item);
    if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error("官方一起听仅支持网易云歌曲 ID");
    return id;
  });
};

/** 复用网易云登录态，实时请求禁用传输重试以避免重复控制或重复建房
 * @param query - 接口参数与会话
 * @param request - 平台请求函数
 * @param path - 官方接口路径
 * @param data - 业务参数
 * @param crypto - 接口使用的加密方式
 */
const call = async (
  query: Query,
  request: RequestFn,
  path: string,
  data: Record<string, unknown>,
  crypto: "eapi" | "weapi" = "eapi",
) => {
  const cookie = typeof query.cookie === "string" ? cookieToJson(query.cookie) : query.cookie;
  if (!cookie?.MUSIC_U) throw new Error("请先登录网易云音乐账号");
  const options = createOption(query, crypto);
  const response = await request(path, data, {
    ...options,
    crypto,
    client: undefined,
    retry: false,
  });
  const body = response.body as {
    code?: number;
    message?: string;
    msg?: string;
    data?: { result?: boolean; success?: boolean; message?: string };
  };
  if (body.code !== 200 || body.data?.result === false || body.data?.success === false)
    throw new Error(body.data?.message || body.message || body.msg || "网易云一起听操作未成功");
  return response;
};

/** 官方一起听接口集，先验证协议再接入播放器，保持自建房间独立 */
export const listenTogetherModules: Record<string, NeteaseModule> = {
  listentogether_status: (q, request) =>
    call(q, request, "/api/listen/together/status/get", {}, "weapi"),
  listentogether_room_create: (q, request) =>
    call(q, request, "/api/listen/together/room/create", { refer: "songplay_more" }),
  listentogether_room_check: (q, request) =>
    call(q, request, "/api/listen/together/room/check", { roomId: identifier(q, "roomId") }),
  listentogether_accept: (q, request) =>
    call(q, request, "/api/listen/together/play/invitation/accept", {
      roomId: identifier(q, "roomId"),
      inviterId: identifier(q, "inviterId"),
      refer: "inbox_invite",
    }),
  listentogether_end: (q, request) =>
    call(q, request, "/api/listen/together/end/v2", { roomId: identifier(q, "roomId") }),
  listentogether_heatbeat: (q, request) =>
    call(q, request, "/api/listen/together/heartbeat", {
      roomId: identifier(q, "roomId"),
      songId: songIds([q.songId])[0],
      playStatus: playStatus(q),
      progress: integer(q, "progress"),
    }),
  listentogether_sync_playlist_get: (q, request) =>
    call(q, request, "/api/listen/together/sync/playlist/get", { roomId: identifier(q, "roomId") }),
  /** 序列号由房间会话维护，服务端结果为 false 时不伪装成功
   * @param q - 控制指令、毫秒进度和客户端序列号
   * @param request - 平台请求函数
   */
  listentogether_play_command: (q, request) => {
    const commandType = String(q.commandType).toUpperCase();
    if (!["GOTO", "PLAY", "PAUSE", "SEEK"].includes(commandType))
      throw new Error("网易云一起听控制指令无效");
    const formerSongId = q.formerSongId === "-1" ? "-1" : songIds([q.formerSongId])[0];
    return call(q, request, "/api/listen/together/play/command/report", {
      roomId: identifier(q, "roomId"),
      commandInfo: JSON.stringify({
        commandType,
        progress: integer(q, "progress"),
        playStatus: playStatus(q),
        formerSongId,
        targetSongId: songIds([q.targetSongId])[0],
        clientSeq: integer(q, "clientSeq"),
      }),
    });
  },
  /** 首版仅开放已实测的整表替换，避免未经验证的增量指令破坏官方队列
   * @param q - 完整网易云列表和版本
   * @param request - 平台请求函数
   */
  listentogether_sync_list_command: (q, request) => {
    if (q.commandType !== "REPLACE") throw new Error("官方歌单目前仅验证了整表替换");
    const displayList = songIds(q.displayList);
    const randomList = songIds(q.randomList ?? q.displayList);
    const sortedRandom = [...randomList].sort();
    if (
      displayList.length !== randomList.length ||
      [...displayList].sort().some((id, i) => id !== sortedRandom[i])
    )
      throw new Error("网易云一起听随机列表与显示列表不一致");
    return call(q, request, "/api/listen/together/sync/list/command/report", {
      roomId: identifier(q, "roomId"),
      playlistParam: JSON.stringify({
        commandType: "REPLACE",
        version: [{ userId: identifier(q, "userId"), version: integer(q, "version") }],
        anchorSongId: "",
        anchorPosition: -1,
        displayList,
        randomList,
      }),
    });
  },
};
