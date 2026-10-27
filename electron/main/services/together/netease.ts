import type {
  TogetherCommand,
  TogetherSnapshot,
  TogetherStatus,
  TogetherTrack,
} from "../../../../shared/types/together";
import type { NeteaseSong } from "../../../../shared/types/platform/netease";
import { cleanAvatar } from "./room";

export type OfficialApi = (
  name: string,
  params?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
interface RoomInfo {
  roomId: string;
  creatorId: number;
  roomUsers: Array<{ userId: number; nickname: string; avatarUrl?: string }>;
}
interface PlayCommand {
  targetSongId: string;
  progress: number;
  playStatus: string;
  serverSeq: number;
  clientSeq: number;
}
interface PlaylistData {
  playCommand?: PlayCommand;
  playlist?: {
    displayList?: { result?: string[] };
    version?: Array<{ userId: number; version: number }>;
  };
}

/** 校验分享地址，只接受官方一起听页面，绝不跟随任意外部地址
 * @param text - 官方分享文案或链接
 */
export const parseNeteaseInvite = (
  text: string,
): { roomId: string; inviterId: string; url: string } => {
  const found = text.match(/https:\/\/[^\s<>"，。)]+/);
  const url = new URL(found?.[0] || text.trim());
  if (
    url.protocol !== "https:" ||
    url.hostname !== "st.music.163.com" ||
    !url.pathname.startsWith("/listen-together/share/") ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error("请粘贴网易云官方一起听分享链接");
  const roomId = url.searchParams.get("roomId") || "";
  const inviterId = url.searchParams.get("inviterId") || "";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(roomId) || !/^[1-9]\d{0,19}$/.test(inviterId))
    throw new Error("网易云分享链接缺少房间或邀请者信息");
  return { roomId, inviterId, url: url.href };
};

/** 官方协议适配器，仅保存当前房间的有界轻量队列，控制与查询串行执行 */
export class NeteaseTogether {
  private room: RoomInfo | null = null;
  private snapshot: TogetherSnapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private serial: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;
  private localReady = false;
  private revision = 0;
  private queueRevision = 0;
  private playKey = "";
  private idsKey = "";
  private seq = 0;
  private listVersion = 0;
  private serverOffset = 0;
  private heartbeatAt = 0;
  private statusAt = 0;
  private elapsed = 0;
  private countedAt = Date.now();
  private tracks: TogetherTrack[] = [];
  private hosting = false;
  private invite = "";

  /** 注入平台入口，账号必须固定到开始连接时的网易云会话
   * @param api - 已校验业务成功的平台接口
   * @param publish - 主进程状态推送
   */
  constructor(
    private api: OfficialApi,
    private publish: (state: TogetherStatus) => void,
  ) {}

  /** 读取当前连接状态
   * @param connection - 连接阶段
   * @param error - 可选错误消息
   */
  private state(connection: TogetherStatus["connection"], error = ""): void {
    if (connection === "reconnecting" && this.snapshot) {
      const now = Date.now();
      if (this.snapshot.counting) this.elapsed += Math.max(0, now - this.countedAt);
      this.countedAt = now;
      this.localReady = false;
      this.snapshot = { ...this.snapshot, counting: false, elapsedMs: this.elapsed };
    }
    this.publish({
      mode: "netease",
      connection,
      invite: this.invite,
      hosting: this.hosting,
      error,
      snapshot: this.snapshot,
    });
  }

  /** 加入官方邀请或创建可被官方 App 加入的房间
   * @param invite - 已解析短链接后的官方地址，省略则建房
   */
  async start(invite?: string): Promise<void> {
    this.state("connecting");
    const current = await this.api("listentogether_status");
    const currentData = current.data as { inRoom?: boolean; roomInfo?: RoomInfo };
    let data: { roomInfo?: RoomInfo };
    if (invite) {
      const parsed = parseNeteaseInvite(invite);
      this.invite = parsed.url;
      if (currentData?.inRoom && currentData.roomInfo?.roomId !== parsed.roomId)
        throw new Error("网易云账号已在另一个官方房间，请先在官方 App 退出");
      data = currentData?.inRoom
        ? currentData
        : ((await this.api("listentogether_accept", parsed)).data as typeof data);
    } else {
      if (currentData?.inRoom) throw new Error("网易云账号已有官方房间，请使用其分享链接加入");
      this.hosting = true;
      data = (await this.api("listentogether_room_create")).data as typeof data;
    }
    if (!data?.roomInfo?.roomId) throw new Error("网易云未返回有效房间");
    this.room = data.roomInfo;
    if (!this.invite)
      this.invite = `https://st.music.163.com/listen-together/share/index.html?roomId=${encodeURIComponent(this.room.roomId)}&inviterId=${this.room.creatorId}`;
    await this.refresh();
    this.schedule();
  }

  /** 将轮询或控制排入单一有界在途链
   * @param task - 当前操作
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    if (this.pendingCount >= 16) return Promise.reject(new Error("操作过于频繁，请稍候"));
    this.pendingCount++;
    const next = this.serial.then(async () => {
      try {
        if (!this.stopped) await task();
      } finally {
        this.pendingCount--;
      }
    });
    this.serial = next.catch(() => {});
    return next;
  }

  /** 只读查询遇到临时网络错误时重试一次，写入操作绝不自动重放
   * @param name - 状态、队列或歌曲详情查询
   * @param params - 查询参数
   */
  private async read(
    name: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.api(name, params);
    } catch (error) {
      if (
        this.stopped ||
        !(error instanceof Error) ||
        !/502|timeout|timed out|aborted|fetch failed|EAI_AGAIN|ECONNRESET/i.test(error.message)
      )
        throw error;
      return this.api(name, params);
    }
  }

  /** 完成本轮请求后再调度，慢网时不会堆积轮询 */
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.enqueue(() => this.refresh())
        .catch((error) => {
          if (!this.stopped)
            this.state(
              "reconnecting",
              error instanceof Error && /502|timeout|timed out|aborted/i.test(error.message)
                ? "网易云房间同步暂时超时，正在自动重试；当前歌曲继续播放"
                : error instanceof Error
                  ? error.message
                  : "网易云房间连接中断",
            );
        })
        .finally(() => this.schedule());
    }, 2000);
  }

  /** 读取官方队列与最后控制，按服务端时间推进，不回传查询结果 */
  private async refresh(): Promise<void> {
    if (!this.room || this.stopped) return;
    if (Date.now() - this.statusAt > 10000) {
      const data = (await this.read("listentogether_status")).data as {
        inRoom?: boolean;
        roomInfo?: RoomInfo;
      };
      if (!data?.inRoom || data.roomInfo?.roomId !== this.room.roomId) {
        this.stop();
        this.snapshot = null;
        this.state("idle", "网易云一起听已结束");
        return;
      }
      this.room = data.roomInfo;
      this.statusAt = Date.now();
    }
    const data = (await this.read("listentogether_sync_playlist_get", { roomId: this.room.roomId }))
      .data as PlaylistData;
    const command = data?.playCommand;
    const ids = (data?.playlist?.displayList?.result ?? []).map(String);
    if (ids.length > 2000 || ids.some((id) => !/^[1-9]\d{0,19}$/.test(id)))
      throw new Error("官方房间歌曲列表无效或超过 2000 首");
    const target = String(command?.targetSongId || "");
    if (target && /^[1-9]\d{0,19}$/.test(target) && !ids.includes(target)) ids.push(target);
    if (ids.length > 2000) throw new Error("官方房间歌曲列表超过 2000 首");
    const key = ids.join(",");
    if (key !== this.idsKey) {
      const existing = new Map(this.tracks.map((t) => [t.id, t]));
      const missing = ids.filter((id) => !existing.has(id));
      for (let i = 0; i < missing.length; i += 500) {
        const result = await this.read("song_detail", { ids: missing.slice(i, i + 500).join(",") });
        for (const song of (result.songs ?? []) as NeteaseSong[]) {
          const album = song.al ?? song.album;
          const cover = album?.picUrl ? `${album.picUrl}?param=300y300` : undefined;
          existing.set(String(song.id), {
            id: String(song.id),
            source: "netease",
            title: song.name,
            artists: (song.ar ?? song.artists ?? []).map((a) => ({
              id: String(a.id),
              name: a.name,
            })),
            duration: song.dt ?? song.duration ?? 0,
            cover,
            fee: song.fee,
            album: album ? { id: String(album.id), name: album.name, cover } : undefined,
          });
        }
      }
      if (ids.some((id) => !existing.has(id)))
        throw new Error("部分官方歌曲详情未能加载，请稍后重试");
      this.tracks = ids.map((id) => existing.get(id)!);
      this.idsKey = key;
      this.queueRevision++;
    }
    this.listVersion = Math.max(
      this.listVersion,
      ...(data?.playlist?.version ?? []).map((v) => v.version),
    );
    this.seq = Math.max(this.seq, Number(command?.clientSeq) || 0);
    const playKey = JSON.stringify([
      command?.serverSeq,
      target,
      command?.playStatus,
      command?.progress,
    ]);
    if (playKey !== this.playKey) {
      this.playKey = playKey;
      this.revision++;
      this.localReady = false;
    }
    const index = Math.max(
      0,
      this.tracks.findIndex((t) => t.id === target),
    );
    const playing = command?.playStatus === "PLAY" && this.tracks.length > 0;
    const serverNow = Date.now() + this.serverOffset;
    const age =
      command?.serverSeq && command.serverSeq > 1e12
        ? Math.max(0, serverNow - command.serverSeq)
        : 0;
    const position = Math.min(
      this.tracks[index]?.duration ?? 0,
      Math.max(0, Number(command?.progress) || 0) + (playing ? age : 0),
    );
    const now = Date.now();
    if (this.snapshot?.counting) this.elapsed += Math.max(0, now - this.countedAt);
    this.countedAt = now;
    const members = this.room.roomUsers.map((u) => ({
      id: String(u.userId),
      name: u.nickname,
      avatar: u.avatarUrl
        ? cleanAvatar(u.avatarUrl)
            ?.replace(/^http:/, "https:")
            ?.replace(/(?:\?param=\d+y\d+)?$/, "?param=100y100")
        : undefined,
      online: true,
      ready: true,
    }));
    this.snapshot = {
      revision: this.revision,
      queueRevision: this.queueRevision,
      serverTime: serverNow,
      tracks: this.tracks,
      index,
      position,
      playing,
      desiredPlaying: playing,
      members,
      elapsedMs: this.elapsed,
      counting: playing && members.length >= 2 && this.localReady,
      chat: [],
    };
    if (Date.now() - this.heartbeatAt > 10000 && this.tracks[index]) {
      const beat = (
        await this.api("listentogether_heatbeat", {
          roomId: this.room.roomId,
          songId: this.tracks[index].id,
          playStatus: this.localReady && playing ? "PLAY" : "PAUSE",
          progress: Math.round(position),
        })
      ).data as { time?: number };
      if (beat?.time) this.serverOffset = beat.time - Date.now();
      this.heartbeatAt = Date.now();
    }
    if (!this.stopped) this.state("connected");
  }

  /** 从现有播放器接收控制，查询和准备事件绝不生成共享暂停
   * @param message - 通用一起听控制消息
   */
  send(message: unknown): Promise<void> {
    return this.enqueue(async () => {
      const value = message as { type?: string; revision?: number; command?: TogetherCommand };
      if (value.type === "profile") return;
      if (value.type === "ready") {
        if (value.revision === this.revision) this.localReady = true;
        return;
      }
      if (value.type === "unavailable") {
        this.localReady = false;
        return;
      }
      if (value.type === "ended") {
        if (!this.hosting || !this.snapshot?.playing) return;
        const revision = this.revision;
        await this.refresh();
        if (revision !== this.revision || !this.snapshot) return;
        const track = this.tracks[this.snapshot.index];
        if (!track || this.snapshot.position < track.duration - 2000) {
          this.localReady = false;
          return;
        }
        if (this.tracks.length > 1) await this.control({ type: "next" });
        else await this.control({ type: "seek", position: 0 });
        await this.refresh();
        return;
      }
      if (value.type !== "command" || !value.command) throw new Error("官方房间暂不支持此操作");
      await this.refresh();
      if (!this.snapshot || !this.room || this.stopped) throw new Error("官方房间已结束");
      await this.control(value.command);
      await this.refresh();
    });
  }

  /** 将双方同权控制转换为官方序列指令
   * @param command - 用户主动发起的播放或队列操作
   */
  private async control(command: TogetherCommand): Promise<void> {
    const snapshot = this.snapshot!;
    const formerSongId = snapshot.tracks[snapshot.index]?.id || "-1";
    let tracks = [...snapshot.tracks];
    let target = formerSongId;
    let position = snapshot.position;
    let playing = snapshot.playing;
    let replace = false;
    let playCommand = "GOTO";
    switch (command.type) {
      case "play":
        playing = true;
        playCommand = "PLAY";
        break;
      case "pause":
        playing = false;
        playCommand = "PAUSE";
        break;
      case "seek":
        position = command.position;
        playCommand = "SEEK";
        break;
      case "next":
      case "prev": {
        if (tracks.length < 2) throw new Error("队列只有一首歌，请先添加歌曲");
        const index =
          (snapshot.index + (command.type === "next" ? 1 : -1) + tracks.length) % tracks.length;
        target = tracks[index].id;
        position = 0;
        break;
      }
      case "queue":
        tracks = [...command.tracks];
        target = tracks[command.index]?.id;
        position = 0;
        playing = true;
        replace = true;
        break;
      case "playTrack":
        if (!tracks.some((t) => t.id === command.track.id && t.source === command.track.source)) {
          tracks.splice(snapshot.index + 1, 0, command.track);
          replace = true;
        }
        target = command.track.id;
        position = 0;
        playing = true;
        break;
      case "enqueue": {
        const fresh = command.tracks.filter(
          (t, i, all) =>
            !tracks.some((x) => x.id === t.id && x.source === t.source) &&
            all.findIndex((x) => x.id === t.id && x.source === t.source) === i,
        );
        tracks.splice(command.position === "end" ? tracks.length : snapshot.index + 1, 0, ...fresh);
        replace = true;
        break;
      }
      case "remove": {
        tracks = tracks.filter(
          (t) => t.id !== command.track.id || t.source !== command.track.source,
        );
        if (!tracks.some((t) => t.id === target)) {
          target = tracks[Math.min(snapshot.index, tracks.length - 1)]?.id;
          position = 0;
        }
        replace = true;
        break;
      }
      case "move": {
        const from = tracks.findIndex(
          (t) => t.id === command.track.id && t.source === command.track.source,
        );
        if (from < 0) return;
        const [track] = tracks.splice(from, 1);
        const to = command.before
          ? tracks.findIndex(
              (t) => t.id === command.before!.id && t.source === command.before!.source,
            )
          : tracks.length;
        if (to < 0) return;
        tracks.splice(to, 0, track);
        replace = true;
        break;
      }
      case "clear":
        throw new Error("官方一起听暂不支持清空列表，可以播放另一个歌单");
      case "mode":
        throw new Error("官方房间暂不支持同步播放模式，请使用自建房间");
    }
    if (!tracks.length) {
      if (command.type === "pause") return;
      throw new Error("官方房间还没有歌曲，请先播放一个网易云歌单或选择歌曲");
    }
    if (tracks.length > 2000) throw new Error("网易云官方一起听最多支持 2000 首歌曲");
    if (tracks.some((t) => t.source !== "netease"))
      throw new Error("网易云官方房间仅支持网易云歌曲，跨平台歌曲请使用自建房间");
    const invalid = tracks.find((t) => !/^[1-9]\d{0,19}$/.test(t.id));
    if (invalid) throw new Error(`歌曲「${invalid.title}」的网易云编号无效，请重新加载原歌单`);
    if (!target || !tracks.some((t) => t.id === target)) throw new Error("官方歌曲索引无效");
    if (
      !Number.isFinite(position) ||
      position < 0 ||
      position > (tracks.find((t) => t.id === target)?.duration ?? 0)
    )
      throw new Error("播放进度无效");
    if (replace) {
      const account = await this.api("user_account");
      const userId =
        (account.profile as { userId?: number })?.userId ??
        (account.account as { id?: number })?.id;
      if (!userId) throw new Error("无法确认网易云账号");
      await this.api("listentogether_sync_list_command", {
        roomId: this.room!.roomId,
        commandType: "REPLACE",
        userId,
        version: ++this.listVersion,
        displayList: tracks.map((t) => t.id),
      });
      if (target === formerSongId && command.type !== "queue" && command.type !== "playTrack")
        return;
    }
    await this.api("listentogether_play_command", {
      roomId: this.room!.roomId,
      commandType: playCommand,
      formerSongId,
      targetSongId: target,
      progress: Math.round(position),
      playStatus: playing ? "PLAY" : "PAUSE",
      clientSeq: ++this.seq,
    });
  }

  /** 停止本机轮询，不自动结束对方的官方房间 */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 用户主动结束官方一起听后清理本机会话 */
  async leave(): Promise<void> {
    await this.enqueue(async () => {
      if (this.room) await this.api("listentogether_end", { roomId: this.room.roomId });
      this.stop();
      this.snapshot = null;
      this.state("idle");
    });
  }
}
