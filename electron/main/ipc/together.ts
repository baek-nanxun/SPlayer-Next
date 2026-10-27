import { app, ipcMain } from "electron";
import { QQMusicTogether } from "@main/services/together/qqmusic";
import { createQQTogetherApi, parseQQTogetherInvite } from "@main/apis/qqmusic/core/together";
import { getQQMusicCookies, getQQMusicUin, qmRequest } from "@main/apis/qqmusic/core/request";
import type { TogetherTrack } from "@shared/types/together";
import { callNetease, getNeteaseCookies } from "@main/apis/netease";
import { NeteaseTogether, parseNeteaseInvite } from "@main/services/together/netease";
import { fetchNeteaseDirect } from "@main/apis/netease/core/direct";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { selectTogetherAddress, togetherConnectionError } from "@main/services/together/network";
import WebSocket from "ws";
import { sendToMain } from "@main/utils/broadcast";
import { cleanAvatar, cleanTracks, startTogetherServer } from "@main/services/together/room";
import { TOGETHER_MAX_PAYLOAD } from "@shared/types/together";
import type { TogetherStatus } from "@shared/types/together";

/** 注册双人房间连接，凭据仅用于房间，不传音乐账号 Cookie */
export const registerTogetherIpc = (): void => {
  let official: NeteaseTogether | QQMusicTogether | null = null;
  let server: Awaited<ReturnType<typeof startTogetherServer>> | null = null;
  let socket: WebSocket | null = null;
  let reconnect: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let generation = 0;
  let state: TogetherStatus = {
    connection: "idle",
    invite: "",
    hosting: false,
    error: "",
    snapshot: null,
  };
  /** 推送连接状态 */
  const publish = (): void => sendToMain("together:status", state);
  /** 关闭当前连接与本机房间 */
  const leave = (): void => {
    official?.stop();
    official = null;
    generation++;
    if (reconnect) clearTimeout(reconnect);
    reconnect = null;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "leave" }));
    socket?.terminate();
    socket = null;
    server?.close();
    server = null;
    state = { connection: "idle", invite: "", hosting: false, error: "", snapshot: null };
    publish();
  };
  /** 连接并在短暂断网后恢复原成员
   * @param invite - 包含服务地址和房间密钥的邀请码
   * @param name - 成员显示名称
   * @param avatar - 可选账号头像
   */
  const connect = (invite: string, name: string, avatar?: string): void => {
    if (invite.length > 3000) throw new Error("邀请码无效");
    const decoded = JSON.parse(
      Buffer.from(invite.replace(/^splayer-together:/, ""), "base64url").toString(),
    );
    const url = new URL(decoded.url);
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      typeof decoded.secret !== "string" ||
      decoded.secret.length < 20
    )
      throw new Error("邀请码无效");
    const epoch = generation,
      id = randomBytes(24).toString("base64url");
    state.invite = invite;
    state.connection = "connecting";
    attempts = 0;
    /** 建立当前代次的 WebSocket */
    const open = (): void => {
      if (epoch !== generation) return;
      const ws = new WebSocket(url, { maxPayload: TOGETHER_MAX_PAYLOAD, handshakeTimeout: 8000 });
      socket = ws;
      ws.on("open", () =>
        ws.send(
          JSON.stringify({
            type: "join",
            secret: decoded.secret,
            id,
            avatar: cleanAvatar(avatar),
            name: name.slice(0, 40) || "听友",
          }),
        ),
      );
      ws.on("message", (data) => {
        if (epoch !== generation) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "state") {
            const v = msg.state;
            if (
              !v ||
              !Number.isSafeInteger(v.revision) ||
              !Number.isFinite(v.serverTime) ||
              !Number.isFinite(v.position) ||
              v.position < 0 ||
              !Number.isFinite(v.elapsedMs) ||
              v.elapsedMs < 0 ||
              !Array.isArray(v.members) ||
              v.members.length > 2 ||
              !Array.isArray(v.chat) ||
              v.chat.length > 50 ||
              typeof v.playing !== "boolean" ||
              typeof v.counting !== "boolean" ||
              typeof v.desiredPlaying !== "boolean"
            )
              throw new Error("房间快照无效");
            const tracks =
              Array.isArray(v.tracks) && v.tracks.length === 0 ? [] : cleanTracks(v.tracks);
            if (
              !Number.isInteger(v.index) ||
              v.index < 0 ||
              (tracks.length && v.index >= tracks.length)
            )
              throw new Error("房间歌曲索引无效");
            msg.state = {
              revision: v.revision,
              queueRevision: Number.isSafeInteger(v.queueRevision) ? v.queueRevision : v.revision,
              serverTime: v.serverTime,
              position: v.position,
              elapsedMs: v.elapsedMs,
              playing: v.playing,
              desiredPlaying: v.desiredPlaying,
              counting: v.counting,
              index: v.index,
              tracks,
              members: v.members.map(
                (m: {
                  id: unknown;
                  name: unknown;
                  online: unknown;
                  ready: unknown;
                  avatar?: unknown;
                }) => ({
                  id: String(m.id).slice(0, 80),
                  name: String(m.name).slice(0, 40),
                  online: m.online === true,
                  ready: m.ready === true,
                  avatar: cleanAvatar(m.avatar),
                }),
              ),
              chat: v.chat.map((c: { id: unknown; name: unknown; text: unknown }) => ({
                id: Number(c.id) || 0,
                name: String(c.name).slice(0, 40),
                text: String(c.text).slice(0, 500),
              })),
            };
            state = { ...state, connection: "connected", snapshot: msg.state, error: "" };
            attempts = 0;
          } else if (msg.type === "error") state.error = String(msg.error).slice(0, 200);
          publish();
        } catch {
          state.error = "房间响应无效";
          publish();
        }
      });
      ws.on("error", (error) => {
        if (epoch !== generation) return;
        state.error = togetherConnectionError(error, url);
        publish();
      });
      ws.on("close", (code) => {
        if (epoch !== generation) return;
        state.connection = "reconnecting";
        publish();
        if (code === 1008 || ++attempts > 20) {
          state.error = state.error || "无法连接房间，请检查邀请码或房间是否已关闭";
          state.connection = "idle";
          state.snapshot = null;
          publish();
          return;
        }
        reconnect = setTimeout(open, 2000);
      });
    };
    open();
    publish();
  };
  /** 创建独立的官方适配器，网易云退出或切换账号后不再继续控制旧房间 */
  const officialClient = (): NeteaseTogether => {
    const musicU = getNeteaseCookies().MUSIC_U;
    if (!musicU) throw new Error("请先登录网易云音乐账号");
    const epoch = generation;
    return new NeteaseTogether(
      async (name, params) => {
        if (getNeteaseCookies().MUSIC_U !== musicU)
          throw new Error("网易云账号已变更，请重新加入房间");
        const result = await callNetease(name, params);
        if (getNeteaseCookies().MUSIC_U !== musicU)
          throw new Error("网易云账号已变更，请重新加入房间");
        return result.body as Record<string, unknown>;
      },
      (latest) => {
        if (epoch !== generation) return;
        state = latest;
        publish();
      },
    );
  };
  /** 固定 QQ 官方房间的音乐账号，查询与控制均复用已有登录态 */
  const qqClient = (): QQMusicTogether => {
    const cookies = getQQMusicCookies();
    const key = cookies.qm_keyst || cookies.qqmusic_key || "";
    const uin = getQQMusicUin();
    if (!key || uin === "0") throw new Error("请先登录 QQ 音乐账号");
    const epoch = generation;
    const api = createQQTogetherApi(qmRequest, () => {
      const current = getQQMusicCookies();
      const musicKey = current.qm_keyst || current.qqmusic_key || "";
      if (getQQMusicUin() !== uin || musicKey !== key)
        throw new Error("QQ 音乐账号已变更，请重新加入房间");
      return { uin, musicKey };
    });
    return new QQMusicTogether(
      api,
      (latest) => {
        if (epoch !== generation) return;
        state = latest;
        publish();
      },
      [uin, cookies.euin || ""],
    );
  };
  /** 只在 QQ 音乐官方短链和分享域名之间展开邀请
   * @param text - 分享文案
   */
  const resolveQQInvite = async (text: string): Promise<string> => {
    const found = text.match(/https:\/\/[^\s<>"，。)]+/);
    let url = new URL(found?.[0] || text.trim());
    for (let i = 0; i < 5; i++) {
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        !["c.y.qq.com", "c6.y.qq.com", "i.y.qq.com", "i2.y.qq.com", "y.qq.com"].includes(
          url.hostname,
        )
      )
        throw new Error("请粘贴 QQ 音乐官方一起听分享链接");
      if (url.searchParams.has("showid")) return parseQQTogetherInvite(url.href).url;
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000) });
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || response.status < 300 || response.status >= 400)
        throw new Error("QQ 音乐短链接未返回有效房间");
      url = new URL(location, url);
    }
    throw new Error("QQ 音乐分享链接跳转过多");
  };
  ipcMain.handle(
    "together:hostQQMusic",
    async (_event, tracks: TogetherTrack[], index: number, position: number) => {
      if (state.connection !== "idle") throw new Error("请先退出当前一起听");
      const cleaned = cleanTracks(tracks);
      if (cleaned.some((t) => t.source !== "qqmusic"))
        throw new Error("请先选择并播放 QQ 音乐歌单，再创建 QQ 官方房间");
      leave();
      official = qqClient();
      try {
        await official.host(cleaned, index, position);
      } catch (error) {
        leave();
        throw error;
      }
    },
  );
  /** 只沿官方短链和分享域名解析分享文案，不访问其他地址
   * @param text - 包含官方链接的分享文案
   */
  const resolveInvite = async (text: string): Promise<string> => {
    const found = text.match(/https:\/\/[^\s<>"，。)]+/);
    let url = new URL(found?.[0] || text.trim());
    for (let i = 0; i < 5; i++) {
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        !["163cn.tv", "st.music.163.com"].includes(url.hostname)
      )
        throw new Error("请使用网易云官方一起听分享链接");
      if (url.hostname === "st.music.163.com") return parseNeteaseInvite(url.href).url;
      const response = await fetchNeteaseDirect(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || response.status < 300 || response.status >= 400)
        throw new Error("网易云短链接未返回有效房间");
      url = new URL(location, url);
    }
    throw new Error("网易云分享链接跳转过多");
  };
  ipcMain.handle("together:hostNetease", async () => {
    if (state.connection !== "idle") throw new Error("请先退出当前一起听");
    leave();
    official = officialClient();
    try {
      await official.start();
    } catch (error) {
      leave();
      throw error;
    }
  });
  ipcMain.handle("together:status", () => state);
  ipcMain.handle(
    "together:host",
    async (_event, name: string, address?: string, avatar?: string) => {
      if (state.connection !== "idle") throw new Error("请先退出当前一起听");
      const host = selectTogetherAddress(networkInterfaces(), address);
      leave();
      server = await startTogetherServer();
      state.hosting = true;
      const invite =
        "splayer-together:" +
        Buffer.from(
          JSON.stringify({ url: `ws://${host}:${server.port}`, secret: server.secret }),
        ).toString("base64url");
      connect(invite, String(name), avatar);
      return invite;
    },
  );
  ipcMain.handle("together:join", async (_event, invite: string, name: string, avatar?: string) => {
    if (state.connection !== "idle") throw new Error("请先退出当前一起听");
    const value = String(invite).trim();
    if (value.includes("https://")) {
      const first = value.match(/https:\/\/[^\s<>"，。)]+/)?.[0];
      const qq = first
        ? ["c.y.qq.com", "c6.y.qq.com", "i.y.qq.com", "i2.y.qq.com", "y.qq.com"].includes(
            new URL(first).hostname,
          )
        : false;
      const link = await (qq ? resolveQQInvite(value) : resolveInvite(value));
      leave();
      official = qq ? qqClient() : officialClient();
      try {
        await official.start(link);
      } catch (error) {
        leave();
        throw error;
      }
    } else {
      leave();
      connect(value, String(name), avatar);
    }
  });
  ipcMain.handle("together:send", (_event, message: unknown) => {
    if (official) return official.send(message);
    if (socket?.readyState !== WebSocket.OPEN) throw new Error("房间连接中，请稍候");
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > TOGETHER_MAX_PAYLOAD) throw new Error("房间消息过大");
    socket.send(text);
    return;
  });
  ipcMain.handle("together:leave", async () => {
    if (official) await official.leave();
    leave();
  });
  app.once("before-quit", leave);
};
