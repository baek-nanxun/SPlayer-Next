import { createQQTogetherApi, parseQQTogetherInvite } from "../../apis/qqmusic/core/together";
import type {
  QQTogetherSong,
  QQTogetherTrackInfo,
} from "../../../../shared/types/qqmusic-together";
import type {
  TogetherCommand,
  TogetherStatus,
  TogetherSnapshot,
  TogetherTrack,
} from "../../../../shared/types/together";
import { cleanAvatar } from "./room";

type QQApi = ReturnType<typeof createQQTogetherApi>;
/** 将 QQ 原始元数据裁剪成当前房间使用的轻量曲目
 * @param raw - 官方曲目详情
 */
const track = (raw: QQTogetherTrackInfo): TogetherTrack => {
  if (!raw.id || !raw.mid || !raw.interval) throw new Error("QQ 音乐歌曲详情不完整");
  const cover = raw.album?.mid
    ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${raw.album.mid}.jpg`
    : undefined;
  return {
    id: raw.mid,
    extId: String(raw.id),
    mediaId: raw.file?.media_mid,
    source: "qqmusic",
    title: raw.title,
    artists: (raw.singer ?? []).map((a) => ({ id: a.mid, name: a.name })),
    duration: raw.interval * 1000,
    cover,
    album: raw.album ? { id: raw.album.mid, name: raw.album.name || "", cover } : undefined,
    fee: raw.pay?.payalbum === 1 ? 4 : raw.pay?.payplay === 1 ? 1 : 0,
  };
};

/** QQ 官方房间适配器，复用原有播放器控制，心跳不发送播放指令 */
export class QQMusicTogether {
  private showID = "";
  private invite = "";
  private hosting = false;
  private snapshot: TogetherSnapshot | null = null;
  private tracks: TogetherTrack[] = [];
  private queue: QQTogetherSong[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;
  private stopped = false;
  private localReady = false;
  private revision = 0;
  private queueRevision = 0;
  private mediaVersion = -1;
  private playKey = "";
  private elapsed = 0;
  private countedAt = Date.now();

  /** 注入固定到同一个账号的协议入口
   * @param api - QQ 音乐官方房间接口
   * @param publish - 主进程推送
   * @param ownUins - 当前音乐账号的普通与加密身份，用于恢复房主权限
   */
  constructor(
    private api: QQApi,
    private publish: (state: TogetherStatus) => void,
    private ownUins: readonly string[] = [],
  ) {}

  /** 发布当前连接阶段，重连时立即停止计时
   * @param connection - 连接阶段
   * @param error - 可选提示
   */
  private state(connection: TogetherStatus["connection"], error = ""): void {
    if (connection !== "connected" && this.snapshot) {
      const now = Date.now();
      if (this.snapshot.counting) this.elapsed += Math.max(0, now - this.countedAt);
      this.countedAt = now;
      this.localReady = false;
      this.snapshot = { ...this.snapshot, counting: false, elapsedMs: this.elapsed };
    }
    this.publish({
      mode: "qqmusic",
      connection,
      invite: this.invite,
      hosting: this.hosting,
      error,
      snapshot: this.snapshot,
    });
  }

  /** 加入官方邀请并同步完整队列
   * @param invite - 展开后的官方分享链接
   */
  async start(invite: string): Promise<void> {
    const parsed = parseQQTogetherInvite(invite);
    this.invite = parsed.url;
    this.showID = parsed.showID;
    this.state("connecting");
    const joined = await this.api.join(this.showID, parsed.fromEncryptedUin);
    const entry = joined.entryInfo as { roomInfo?: { createUin?: string } } | undefined;
    const creator = entry?.roomInfo?.createUin;
    this.hosting = !!creator && this.ownUins.includes(creator);
    await this.refresh();
    this.schedule();
  }

  /** 从当前 QQ 播放队列创建官方房间
   * @param tracks - 当前完整队列
   * @param index - 当前歌曲位置
   * @param position - 当前毫秒进度
   */
  async host(tracks: TogetherTrack[], index: number, position: number): Promise<void> {
    this.state("connecting");
    const queue = await this.songList(tracks);
    if (!Number.isSafeInteger(index) || index < 0 || index >= queue.length)
      throw new Error("请先选择一首 QQ 音乐歌曲");
    const created = await this.api.create(queue, index, Math.round(position));
    this.showID = created.entryInfo!.roomInfo!.showID!;
    this.hosting = true;
    this.invite = `https://i.y.qq.com/n2/m/share/listen_together/index.html?showid=${this.showID}&songid=${queue[index].songID}`;
    await this.api.control(this.showID, 3, queue, index, Math.round(position));
    await this.refresh();
    this.schedule();
  }

  /** 所有在途操作有界且串行，避免慢网重复发指令
   * @param task - 下一次操作
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

  /** 完成本轮再调度下一次心跳，不堆积周期请求 */
  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.enqueue(() => this.refresh())
        .catch((error) => {
          if (this.stopped) return;
          const message = error instanceof Error ? error.message : "QQ 官方房间连接中断";
          if (/inner=1100[01]\b/.test(message)) {
            this.stop();
            this.snapshot = null;
            this.state("idle", "QQ 音乐一起听已结束，请使用新邀请");
          } else this.state("reconnecting", message);
        })
        .finally(() => this.schedule());
    }, 2000);
  }

  /** 拉取权威播放状态，仅媒体版本变化时重新加载完整队列 */
  private async refresh(): Promise<void> {
    if (!this.showID || this.stopped) return;
    const frame = await this.api.heartbeat(this.showID);
    if (this.stopped) return;
    if (this.mediaVersion !== frame.mediaVersion || !this.queue.length) {
      const queue = await this.api.playlist(this.showID);
      const old = new Map(this.tracks.map((t) => [Number(t.extId), t]));
      const missing = queue.map((s) => s.songID).filter((id) => !old.has(id));
      for (let i = 0; i < missing.length; i += 100) {
        for (const info of await this.api.tracks(missing.slice(i, i + 100)))
          old.set(info.id, track(info));
        if (this.stopped) return;
      }
      if (queue.some((s) => !old.has(s.songID)))
        throw new Error("QQ 官方房间部分歌曲详情未加载，请稍后重试");
      const key = queue.map((s) => s.songID).join(",");
      if (key !== this.queue.map((s) => s.songID).join(",")) this.queueRevision++;
      this.queue = queue;
      this.tracks = queue.map((s) => old.get(s.songID)!);
      this.mediaVersion = frame.mediaVersion ?? 0;
    }
    const info = frame.songInfo;
    const currentId = info.playingSongInfo?.songID;
    const index = this.queue.findIndex((s) => s.songID === currentId);
    if (index < 0) {
      this.mediaVersion = -1;
      throw new Error("QQ 房间正在更新当前歌曲，稍后重试");
    }
    const playKey = JSON.stringify([currentId, info.songPlayVersion, info.playStatus]);
    if (playKey !== this.playKey) {
      this.playKey = playKey;
      this.revision++;
      this.localReady = false;
    }
    const playing = info.playStatus === 1;
    const now = Date.now();
    if (this.snapshot?.counting) this.elapsed += Math.max(0, now - this.countedAt);
    this.countedAt = now;
    const members = frame.users.map((u) => ({
      id: u.encryptUin || "",
      name: u.nick || u.nickname || "听友",
      avatar: cleanAvatar(u.headUrl || u.avatar)?.replace(/^http:/, "https:"),
      online: true,
      ready: true,
    }));
    this.snapshot = {
      revision: this.revision,
      queueRevision: this.queueRevision,
      serverTime: now,
      tracks: this.tracks,
      index,
      position: Math.min(this.tracks[index].duration, Math.max(0, info.songOffset || 0)),
      playing,
      desiredPlaying: playing,
      members,
      elapsedMs: this.elapsed,
      counting: playing && members.length >= 2 && this.localReady,
      chat: [],
    };
    this.state("connected");
  }

  /** 将本机歌曲解析为实际数字 ID 和歌曲类型，不用 MID 猜测
   * @param tracks - 要共享的 QQ 歌曲列表
   */
  private async songList(tracks: TogetherTrack[]): Promise<QQTogetherSong[]> {
    if (!tracks.length || tracks.length > 1000 || tracks.some((t) => t.source !== "qqmusic"))
      throw new Error("QQ 官方房间仅支持 1–1000 首 QQ 音乐歌曲，跨平台请使用自建房间");
    const existing = new Map(this.tracks.map((t, i) => [t.id, this.queue[i]]));
    const infos = new Map<number, QQTogetherTrackInfo>();
    const numericIds = [
      ...new Set(
        tracks
          .filter((t) => !existing.has(t.id))
          .map((t) => Number(t.extId || (/^\d+$/.test(t.id) ? t.id : 0)))
          .filter((id) => id > 0),
      ),
    ];
    for (let i = 0; i < numericIds.length; i += 100)
      for (const raw of await this.api.tracks(numericIds.slice(i, i + 100))) infos.set(raw.id, raw);
    const output: QQTogetherSong[] = [];
    for (const [index, t] of tracks.entries()) {
      const cached = existing.get(t.id);
      if (cached) {
        output.push({ ...cached, songIndex: index });
        continue;
      }
      const numeric = Number(t.extId || (/^\d+$/.test(t.id) ? t.id : 0));
      const raw = numeric ? infos.get(numeric) : await this.api.resolve(t.id);
      if (!raw || !Number.isSafeInteger(raw.id) || raw.id <= 0 || !Number.isInteger(raw.type))
        throw new Error("QQ 歌曲身份解析失败，未修改官方房间");
      output.push({ songID: raw.id, songType: raw.type, songIndex: index, title: raw.title });
    }
    return output;
  }

  /** 接收原播放器指令，准备和缓冲通知不转换为远端暂停
   * @param message - 通用房间消息
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
        if (
          !this.snapshot ||
          revision !== this.revision ||
          this.snapshot.position < this.tracks[this.snapshot.index].duration - 2000
        )
          return;
        await this.control(
          this.queue.length > 1 ? { type: "next" } : { type: "seek", position: 0 },
        );
        await this.refresh();
        return;
      }
      if (value.type !== "command" || !value.command) throw new Error("QQ 官方房间暂不支持此操作");
      await this.refresh();
      await this.control(value.command);
      await this.refresh();
    });
  }

  /** 将主动播放和完整队列变更提交到 QQ 官方房间
   * @param command - 用户控制
   */
  private async control(command: TogetherCommand): Promise<void> {
    const s = this.snapshot;
    if (!s) throw new Error("QQ 房间尚未连接");
    let tracks = [...this.tracks],
      index = s.index,
      position = s.position;
    let cmd = 4,
      replace = false,
      preserve = false;
    switch (command.type) {
      case "play":
        cmd = 2;
        break;
      case "pause":
        cmd = 3;
        break;
      case "seek":
        cmd = 7;
        position = command.position;
        break;
      case "next":
      case "prev":
        if (tracks.length < 2) throw new Error("队列只有一首歌，请先添加歌曲");
        index = (index + (command.type === "next" ? 1 : -1) + tracks.length) % tracks.length;
        position = 0;
        break;
      case "queue":
        tracks = [...command.tracks];
        index = command.index;
        position = 0;
        replace = true;
        break;
      case "playTrack": {
        const at = tracks.findIndex(
          (t) => t.id === command.track.id && t.source === command.track.source,
        );
        if (at >= 0) index = at;
        else {
          index++;
          tracks.splice(index, 0, command.track);
          replace = true;
        }
        position = 0;
        break;
      }
      case "enqueue": {
        const fresh = command.tracks.filter(
          (t, i, all) =>
            !tracks.some((x) => x.id === t.id && x.source === t.source) &&
            all.findIndex((x) => x.id === t.id && x.source === t.source) === i,
        );
        if (!fresh.length) return;
        tracks.splice(command.position === "end" ? tracks.length : index + 1, 0, ...fresh);
        replace = true;
        preserve = true;
        break;
      }
      case "remove": {
        const target = tracks[index];
        tracks = tracks.filter(
          (t) => t.id !== command.track.id || t.source !== command.track.source,
        );
        const at = tracks.findIndex((t) => t.id === target.id && t.source === target.source);
        preserve = at >= 0;
        index = preserve ? at : Math.min(index, tracks.length - 1);
        if (!preserve) position = 0;
        replace = true;
        break;
      }
      case "move": {
        const current = tracks[index];
        const from = tracks.findIndex(
          (t) => t.id === command.track.id && t.source === command.track.source,
        );
        if (from < 0) return;
        const [t] = tracks.splice(from, 1);
        const at = command.before
          ? tracks.findIndex(
              (x) => x.id === command.before!.id && x.source === command.before!.source,
            )
          : tracks.length;
        if (at < 0) return;
        tracks.splice(at, 0, t);
        index = tracks.findIndex((x) => x.id === current.id);
        replace = true;
        preserve = true;
        break;
      }
      case "clear":
        throw new Error("QQ 官方房间暂不支持清空队列，请播放另一个歌单");
    }
    if (!Number.isSafeInteger(index) || index < 0 || index >= tracks.length)
      throw new Error("QQ 官方歌曲索引无效");
    if (!Number.isFinite(position) || position < 0 || position > tracks[index].duration)
      throw new Error("QQ 官方播放进度无效");
    const queue = await this.songList(tracks);
    if (replace) {
      await this.api.control(this.showID, 1, queue, index, Math.round(position));
      this.mediaVersion = -1;
    }
    if (!preserve) await this.api.control(this.showID, cmd, queue, index, Math.round(position));
  }

  /** 只停止本机同步，不退出或解散其他成员的房间 */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  /** 用户主动退出时仅移除本机音乐账号 */
  async leave(): Promise<void> {
    await this.enqueue(async () => {
      if (this.showID) await this.api.quit(this.showID);
      this.stop();
      this.snapshot = null;
      this.state("idle");
    });
  }
}
