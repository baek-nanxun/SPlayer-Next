import { TOGETHER_MAX_TRACKS, TOGETHER_MAX_PAYLOAD } from "../../../../shared/types/together";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type {
  TogetherCommand,
  TogetherSnapshot,
  TogetherTrack,
} from "../../../../shared/types/together";

/** 校验并裁剪歌曲资料，禁止通过房间传播本地路径或登录凭据
 * @param value - 待共享的歌曲列表
 */
export const cleanTracks = (value: unknown): TogetherTrack[] => {
  if (!Array.isArray(value) || !value.length || value.length > TOGETHER_MAX_TRACKS)
    throw new Error("共享队列需包含 1–2000 首在线歌曲");
  return value.map((v) => {
    if (
      !v ||
      !["qqmusic", "netease"].includes(v.source) ||
      typeof v.id !== "string" ||
      !/^[a-zA-Z0-9]+$/.test(v.id) ||
      v.id.length > 80 ||
      typeof v.title !== "string" ||
      !Number.isFinite(v.duration) ||
      v.duration <= 0 ||
      v.duration > 86400000
    )
      throw new Error("一起听支持 QQ／网易云在线歌曲，请使用有效曲目");
    return {
      id: v.id,
      source: v.source,
      title: v.title.slice(0, 200),
      duration: v.duration,
      extId: typeof v.extId === "string" ? v.extId.slice(0, 80) : undefined,
      mediaId: typeof v.mediaId === "string" ? v.mediaId.slice(0, 80) : undefined,
      artists: Array.isArray(v.artists)
        ? v.artists
            .slice(0, 20)
            .map((a: { name?: unknown }) => ({ name: String(a?.name ?? "").slice(0, 100) }))
        : [],
    };
  });
};

/** 按平台与歌曲 ID 比较身份，避免两个平台数字 ID 冲突
 * @param a - 第一首歌
 * @param b - 第二首歌
 */
const sameTrack = (
  a: Pick<TogetherTrack, "id" | "source">,
  b: Pick<TogetherTrack, "id" | "source">,
): boolean => !!a && !!b && a.id === b.id && a.source === b.source;

/** 只保留正常网页头像地址
 * @param value - 用户头像地址
 */
export const cleanAvatar = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

/** 双人共享状态机，统一排序操作并按双方实际准备状态累计时长 */
export class TogetherRoom {
  revision = 0;
  queueRevision = 0;
  tracks: TogetherTrack[] = [];
  index = 0;
  position = 0;
  playing = false;
  desiredPlaying = false;
  elapsedMs = 0;
  updatedAt: number;
  members = new Map<
    string,
    { name: string; online: boolean; ready: boolean; seen: number; avatar?: string }
  >();
  chat: TogetherSnapshot["chat"] = [];
  constructor(private clock: () => number = Date.now) {
    this.updatedAt = clock();
  }
  /** 结算当前区间，暂停和单人在线均不累计 */
  settle(): void {
    const now = this.clock();
    const dt = Math.max(0, now - this.updatedAt);
    if (this.playing) {
      const heard = Math.min(
        dt,
        Math.max(0, (this.tracks[this.index]?.duration ?? 0) - this.position),
      );
      this.position += heard;
      if (this.counting()) this.elapsedMs += heard;
    }
    this.updatedAt = now;
  }
  /** 获取可发送的权威快照 */
  snapshot(): TogetherSnapshot {
    this.settle();
    return {
      revision: this.revision,
      queueRevision: this.queueRevision,
      serverTime: this.updatedAt,
      position: this.position,
      playing: this.playing,
      desiredPlaying: this.desiredPlaying,
      index: this.index,
      tracks: this.tracks,
      members: [...this.members].map(([id, m]) => ({
        id,
        name: m.name,
        online: m.online,
        ready: m.ready,
        avatar: m.avatar,
      })),
      elapsedMs: this.elapsedMs,
      counting: this.counting(),
      chat: this.chat,
    };
  }
  /** 加入或恢复同一成员，保留短暂断线期间的席位
   * @param id - 成员恢复标识
   * @param name - 显示名称
   * @param avatar - 可选头像地址
   */
  join(id: string, name: string, avatar?: string): void {
    const now = this.clock();
    for (const [key, m] of this.members)
      if (!m.online && now - m.seen > 60000) this.members.delete(key);
    if (!this.members.has(id) && this.members.size >= 2) throw new Error("房间已满，仅支持两人");
    this.settle();
    this.members.set(id, {
      name,
      online: true,
      ready: false,
      seen: now,
      avatar: cleanAvatar(avatar),
    });
  }
  /** 离线时停止共同计时，保持在线听友的播放
   * @param id - 成员标识
   */
  disconnect(id: string): void {
    const m = this.members.get(id);
    if (!m) return;
    this.settle();
    m.online = false;
    m.ready = false;
    m.seen = this.clock();
  }
  /** 显式离开立即释放席位
   * @param id - 成员标识
   */
  leave(id: string): void {
    this.disconnect(id);
    this.members.delete(id);
  }
  /** 开启新一轮准备，避免迟到确认启动错误歌曲 */
  rebuffer(): void {
    this.playing = this.desiredPlaying && this.tracks.length > 0;
    this.revision++;
    for (const m of this.members.values()) m.ready = false;
  }
  /** 记录当前版本的本机准备状态，不改变共享时钟
   * @param id - 确认成员
   * @param revision - 确认对应的版本
   */
  ready(id: string, revision: number): void {
    if (revision !== this.revision) return;
    const m = this.members.get(id);
    if (!m?.online) return;
    this.settle();
    m.ready = true;
  }
  /** 双方实际准备完成才累计，共享播放时钟不等待慢的一方 */
  counting(): boolean {
    return (
      this.playing &&
      this.members.size === 2 &&
      [...this.members.values()].every((m) => m.online && m.ready)
    );
  }
  /** 仅标记当前听友缓冲，不暂停另一端
   * @param id - 缓冲或音源失败的成员
   */
  unavailable(id: string): void {
    this.settle();
    const member = this.members.get(id);
    if (member) member.ready = false;
  }
  /** 串行接受任一成员的控制，相同权限且服务器最后接收的操作生效
   * @param id - 发起成员
   * @param command - 播放操作
   */
  command(id: string, command: TogetherCommand): void {
    if (!this.members.get(id)?.online) throw new Error("请先加入房间");
    this.settle();
    switch (command.type) {
      case "queue": {
        const tracks = cleanTracks(command.tracks);
        if (!Number.isInteger(command.index) || command.index < 0 || command.index >= tracks.length)
          throw new Error("歌曲索引无效");
        this.tracks = tracks;
        this.queueRevision++;
        this.index = command.index;
        this.position = 0;
        this.desiredPlaying = true;
        break;
      }
      case "enqueue": {
        const incoming = cleanTracks(command.tracks);
        if (!["next", "end"].includes(command.position)) throw new Error("插入位置无效");
        const fresh = incoming.filter(
          (t, i) =>
            !this.tracks.some((x) => sameTrack(x, t)) &&
            incoming.findIndex((x) => sameTrack(x, t)) === i,
        );
        if (!fresh.length) return;
        if (this.tracks.length + fresh.length > TOGETHER_MAX_TRACKS)
          throw new Error("共享队列最多 2000 首");
        const at = command.position === "end" ? this.tracks.length : this.index + 1;
        this.tracks = [...this.tracks.slice(0, at), ...fresh, ...this.tracks.slice(at)];
        this.queueRevision++;
        return;
      }
      case "playTrack": {
        const track = cleanTracks([command.track])[0];
        let at = this.tracks.findIndex((t) => sameTrack(t, track));
        if (at < 0) {
          if (this.tracks.length >= TOGETHER_MAX_TRACKS) throw new Error("共享队列最多 2000 首");
          at = this.tracks.length ? this.index + 1 : 0;
          this.tracks = [...this.tracks.slice(0, at), track, ...this.tracks.slice(at)];
          this.queueRevision++;
        }
        if (at === this.index && this.position > 0 && this.desiredPlaying) return;
        if (at !== this.index) this.position = 0;
        this.index = at;
        this.desiredPlaying = true;
        break;
      }
      case "remove": {
        const at = this.tracks.findIndex((t) => sameTrack(t, command.track));
        if (at < 0) return;
        this.tracks = this.tracks.filter((_, i) => i !== at);
        this.queueRevision++;
        if (at < this.index) {
          this.index--;
          return;
        }
        if (at !== this.index) return;
        this.index = this.tracks.length ? this.index % this.tracks.length : 0;
        this.position = 0;
        if (!this.tracks.length) this.desiredPlaying = false;
        break;
      }
      case "move": {
        const from = this.tracks.findIndex((t) => sameTrack(t, command.track));
        if (from < 0) return;
        const current = this.tracks[this.index];
        const rest = this.tracks.filter((_, i) => i !== from);
        const at = command.before
          ? rest.findIndex((t) => sameTrack(t, command.before!))
          : rest.length;
        if (at < 0) return;
        this.tracks = [...rest.slice(0, at), this.tracks[from], ...rest.slice(at)];
        this.index = this.tracks.findIndex((t) => sameTrack(t, current));
        this.queueRevision++;
        return;
      }
      case "clear":
        this.tracks = [];
        this.index = 0;
        this.position = 0;
        this.desiredPlaying = false;
        this.queueRevision++;
        break;
      case "play":
        if (!this.tracks.length) throw new Error("请先选择在线歌曲");
        this.desiredPlaying = true;
        break;
      case "pause":
        this.desiredPlaying = false;
        break;
      case "seek":
        if (
          !Number.isFinite(command.position) ||
          command.position < 0 ||
          command.position > (this.tracks[this.index]?.duration ?? 0)
        )
          throw new Error("播放进度无效");
        this.position = command.position;
        break;
      case "next":
      case "prev":
        if (this.tracks.length < 2) throw new Error("队列只有一首歌，请先选择歌单或添加歌曲");
        this.index =
          (this.index + (command.type === "next" ? 1 : -1) + this.tracks.length) %
          this.tracks.length;
        this.position = 0;
        break;
      default:
        throw new Error("未知房间操作");
    }
    this.rebuffer();
  }
  /** 由房间统一判断自然结束，避免双方重复切歌 */
  tick(): boolean {
    this.settle();
    if (this.playing && this.position >= this.tracks[this.index].duration) {
      this.index = (this.index + 1) % this.tracks.length;
      this.position = 0;
      this.rebuffer();
      return true;
    }
    return false;
  }
}

/** 启动只容纳一个双人房间的服务
 * @param port - 监听端口，0 表示由系统分配
 * @param host - 监听地址
 */
export const startTogetherServer = async (port = 0, host = "0.0.0.0") => {
  const secret = randomBytes(24).toString("base64url");
  const room = new TogetherRoom();
  const wss = new WebSocketServer({
    port,
    host,
    maxPayload: TOGETHER_MAX_PAYLOAD,
    perMessageDeflate: false,
  });
  const peers = new Map<WebSocket, { id: string; alive: boolean; messages: number }>();
  /** 向已认证成员广播共享快照 */
  const publish = (): void => {
    const frame = JSON.stringify({ type: "state", state: room.snapshot() });
    for (const ws of peers.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  };
  wss.on("connection", (ws) => {
    if (wss.clients.size > 10) {
      ws.close(1008);
      return;
    }
    const authTimer = setTimeout(() => ws.close(1008, "登录超时"), 5000);
    ws.on("error", () => {});
    ws.on("pong", () => {
      const p = peers.get(ws);
      if (p) p.alive = true;
    });
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        let p = peers.get(ws);
        if (!p) {
          if (
            msg.type !== "join" ||
            msg.secret !== secret ||
            typeof msg.id !== "string" ||
            !/^[a-zA-Z0-9_-]{20,80}$/.test(msg.id) ||
            typeof msg.name !== "string"
          )
            throw new Error("邀请码无效");
          if ([...peers.values()].some((x) => x.id === msg.id)) throw new Error("成员已连接");
          room.join(msg.id, msg.name.slice(0, 40) || "听友", msg.avatar);
          clearTimeout(authTimer);
          p = { id: msg.id, alive: true, messages: 0 };
          peers.set(ws, p);
          publish();
          return;
        }
        if (++p.messages > 40) throw new Error("操作过于频繁");
        if (msg.type === "command") room.command(p.id, msg.command);
        else if (msg.type === "ready") room.ready(p.id, msg.revision);
        else if (msg.type === "profile") {
          const member = room.members.get(p.id);
          if (member && typeof msg.name === "string") {
            member.name = msg.name.slice(0, 40) || "听友";
            member.avatar = cleanAvatar(msg.avatar);
          }
        } else if (msg.type === "leave") {
          room.leave(p.id);
          peers.delete(ws);
          ws.close();
        } else if (msg.type === "ended") {
          room.settle();
          if (room.playing && room.position < (room.tracks[room.index]?.duration ?? 0) - 2000) {
            room.unavailable(p.id);
            ws.send(
              JSON.stringify({
                type: "error",
                error: "本机歌曲提前结束，可能只有试听权限；听友将继续播放",
              }),
            );
          }
        } else if (msg.type === "unavailable") {
          room.unavailable(p.id);
        } else if (msg.type === "chat" && typeof msg.text === "string" && msg.text.trim()) {
          room.chat = [
            ...room.chat.slice(-49),
            {
              id: Date.now(),
              name: room.members.get(p.id)!.name,
              text: msg.text.trim().slice(0, 500),
            },
          ];
        } else throw new Error("房间消息无效");
        publish();
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: "error",
            error: error instanceof Error ? error.message : "房间消息无效",
          }),
        );
        if (!peers.has(ws)) ws.close(1008);
      }
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      const p = peers.get(ws);
      if (p) {
        peers.delete(ws);
        room.disconnect(p.id);
        publish();
      }
    });
  });
  const pulse = setInterval(() => {
    if (room.tick()) publish();
  }, 250);
  const heartbeat = setInterval(() => {
    for (const [ws, p] of peers) {
      if (!p.alive) {
        ws.terminate();
        continue;
      }
      p.alive = false;
      p.messages = 0;
      ws.ping();
    }
    publish();
  }, 5000);
  try {
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
  } catch (error) {
    clearInterval(pulse);
    clearInterval(heartbeat);
    wss.close();
    throw error;
  }
  return {
    port: (wss.address() as { port: number }).port,
    secret,
    room,
    close: () => {
      clearInterval(pulse);
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
};
