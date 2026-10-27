import { useAccountStore } from "./account";
import { useStatusStore } from "./status";
import { queue as playerQueue } from "./queue";
import { setTogetherControl } from "@/services/togetherBridge";
import {
  applyTogetherQueue,
  applyTogetherSnapshot,
  invalidatePlaybackOperation,
} from "@/core/player";
import { toast } from "@/composables/useToast";
import { TOGETHER_MAX_TRACKS, TOGETHER_MAX_PAYLOAD } from "@shared/types/together";
import type { TogetherCommand, TogetherStatus, TogetherTrack } from "@shared/types/together";

/** 双人房间连接与权威快照应用，加载中只保留最新版本 */
export const useTogetherStore = defineStore("together", () => {
  const state = shallowRef<TogetherStatus>({
    connection: "idle",
    invite: "",
    hosting: false,
    error: "",
    snapshot: null,
  });
  const playbackError = ref("");
  const chatOpen = ref(false);
  const now = ref(Date.now());
  let receivedAt = Date.now();
  let generation = 0;
  let pending: { state: TogetherStatus; received: number; generation: number } | null = null;
  let busy = false;
  let applied = "";
  let applyingRevision = -1;
  let driftAt = 0;
  let retryAt = 0;
  let correctAfter = 0;
  let localSample: { position: number; at: number } | null = null;
  let localReady: boolean | null = null;
  let profileSent = "";
  const elapsed = computed(() => {
    const s = state.value.snapshot;
    return s ? s.elapsedMs + (s.counting ? Math.max(0, now.value - receivedAt) : 0) : 0;
  });
  const durationLabel = computed(() => {
    const sec = Math.floor(elapsed.value / 1000);
    return `${Math.floor(sec / 3600)
      .toString()
      .padStart(
        2,
        "0",
      )}:${Math.floor(sec / 60) % 60 < 10 ? "0" : ""}${Math.floor(sec / 60) % 60}:${(sec % 60).toString().padStart(2, "0")}`;
  });
  /** 发送同权控制操作
   * @param command - 双方均可发起的操作
   */
  const command = (command: TogetherCommand): void => {
    if (state.value.connection !== "connected") {
      toast.warning("房间连接中，请稍候");
      return;
    }
    if (command.type === "mode" && ["netease", "qqmusic"].includes(state.value.mode ?? "")) {
      toast.warning("官方房间暂不支持同步播放模式，请使用自建房间的随机或单曲循环");
      return;
    }
    // 新建官方房间为空时，点击当前歌曲会走播放开关，必须先同步本机列表
    if (command.type === "play" && !state.value.snapshot?.tracks.length) {
      const status = useStatusStore();
      const tracks = [...playerQueue.value];
      const index = tracks.findIndex(
        (t) => t.id === status.currentTrack?.id && t.source === status.currentTrack?.source,
      );
      if (!tracks.length || index < 0) {
        toast.warning("请先选择一个在线歌单或歌曲，开始一起听");
        return;
      }
      command = { type: "queue", tracks, index };
    }
    const tracks =
      command.type === "queue" || command.type === "enqueue"
        ? command.tracks
        : command.type === "playTrack"
          ? [command.track]
          : [];
    if (tracks.length > TOGETHER_MAX_TRACKS) {
      toast.warning("共享歌单最多 2000 首");
      return;
    }
    if (state.value.mode === "qqmusic" && tracks.some((t) => t.source !== "qqmusic")) {
      toast.warning("QQ 官方一起听仅支持 QQ 音乐歌曲，跨平台请使用自建房间");
      return;
    }
    if (state.value.mode === "netease" && tracks.some((t) => t.source !== "netease")) {
      toast.warning("网易云官方一起听仅支持网易云歌曲，跨平台请使用自建房间");
      return;
    }
    if (tracks.some((t) => !["qqmusic", "netease"].includes(t.source))) {
      toast.warning("一起听请使用 QQ 音乐或网易云在线歌曲");
      return;
    }
    /** 只发送必要歌曲资料，完整歌单也不包含本地路径或大封面
     * @param track - 本地歌曲资料
     */
    const compact = (track: TogetherTrack): TogetherTrack => {
      const images = [track.cover, track.album?.cover].map((value) => {
        if (!value || value.length > 2048 || !URL.canParse(value)) return undefined;
        const url = new URL(value);
        return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
          ? url.href
          : undefined;
      });
      return {
        id: track.id,
        source: track.source,
        title: track.title,
        artists: track.artists.map((a) => ({ name: a.name })),
        duration: track.duration,
        extId: track.extId,
        mediaId: track.mediaId,
        cover: images[0] ?? images[1],
        album: track.album
          ? { id: track.album.id, name: track.album.name, cover: images[1] }
          : undefined,
        fee: track.fee,
      };
    };
    const outgoing =
      command.type === "queue" || command.type === "enqueue"
        ? { ...command, tracks: tracks.map(compact) }
        : command.type === "playTrack"
          ? { ...command, track: compact(command.track) }
          : command;
    const message = JSON.stringify({ type: "command", command: outgoing });
    if (new TextEncoder().encode(message).length > TOGETHER_MAX_PAYLOAD) {
      toast.warning("歌单资料过大，请缩小选择范围");
      return;
    }
    void window.api.together.send(JSON.parse(message)).catch((e) => toast.error(String(e)));
  };
  /** 消费最新快照，确认的版本必须与加载结果一致 */
  const drain = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      while (pending) {
        const job = pending;
        pending = null;
        const snapshot = job.state.snapshot;
        if (!snapshot) continue;
        const key = `${snapshot.revision}:${snapshot.playing}`;
        const current = (): boolean => job.generation === generation;
        try {
          if (key === applied) {
            if (snapshot.playing && Date.now() - driftAt > 5000) {
              driftAt = Date.now();
              const res = await window.api.player.getStatus();
              if (job.generation !== generation || !res.success || !res.data) continue;
              const expected = snapshot.position + Date.now() - job.received;
              const stalled =
                !!localSample &&
                Date.now() - localSample.at > 4000 &&
                res.data.position - localSample.position < 500;
              const ready = res.data.state === "playing" && !stalled;
              localSample = { position: res.data.position, at: Date.now() };
              if (ready !== localReady) {
                localReady = ready;
                await window.api.together
                  .send(
                    ready
                      ? { type: "ready", revision: snapshot.revision }
                      : { type: "unavailable" },
                  )
                  .catch(() => {});
              }
              if (!ready && Date.now() >= retryAt && Date.now() >= correctAfter) {
                correctAfter = Date.now() + 20000;
                applied = "";
                retryAt = 0;
                pending = { state: state.value, received: receivedAt, generation };
              } else if (
                ready &&
                expected - res.data.position > 5000 &&
                Date.now() >= correctAfter &&
                snapshot.queueRevision === state.value.snapshot?.queueRevision
              ) {
                correctAfter = Date.now() + 20000;
                await applyTogetherSnapshot(
                  { ...snapshot, position: expected },
                  () => job.generation === generation,
                );
              }
            }
            continue;
          }
          if (Date.now() < retryAt) continue;
          applyingRevision = snapshot.revision;
          const position = snapshot.position + (snapshot.playing ? Date.now() - job.received : 0);
          await applyTogetherSnapshot({ ...snapshot, position }, current);
          if (!current()) continue;
          applied = key;
          playbackError.value = "";
          localReady = true;
          localSample = null;
          await window.api.together.send({ type: "ready", revision: snapshot.revision });
        } catch (error) {
          if (!current()) continue;
          playbackError.value = error instanceof Error ? error.message : "无法同步歌曲";
          applied = "";
          retryAt = Date.now() + 5000;
          localReady = false;
          if (snapshot.desiredPlaying)
            await window.api.together.send({ type: "unavailable" }).catch(() => {});
        }
      }
    } finally {
      busy = false;
    }
  };
  /** 接收房间状态并仅在本机断线时暂停
   * @param latest - 主进程连接状态
   */
  const receive = (latest: TogetherStatus): void => {
    const old = state.value;
    state.value = latest;
    if (latest.connection === "connected") {
      const profile = useAccountStore().profile;
      const key = `${profile?.nickname}:${profile?.avatarUrl}`;
      if (profile && key !== profileSent) {
        profileSent = key;
        void window.api.together
          .send({ type: "profile", name: profile.nickname, avatar: profile.avatarUrl })
          .catch(() => {});
      }
    }
    if (
      latest.snapshot &&
      (latest.snapshot.queueRevision !== old.snapshot?.queueRevision ||
        latest.snapshot.index !== old.snapshot?.index ||
        latest.snapshot.shuffleMode !== old.snapshot?.shuffleMode ||
        latest.snapshot.repeatMode !== old.snapshot?.repeatMode)
    )
      applyTogetherQueue(latest.snapshot);
    receivedAt = Date.now();
    now.value = receivedAt;
    setTogetherControl(latest.connection === "idle" ? null : command);
    if (
      latest.connection === "reconnecting" &&
      (latest.mode === "netease" || latest.mode === "qqmusic") &&
      latest.snapshot
    ) {
      localReady = null;
      driftAt = 0;
      return;
    }
    if (latest.connection !== "connected") {
      generation++;
      pending = null;
      applied = "";
      applyingRevision = -1;
      retryAt = 0;
      correctAfter = 0;
      localReady = null;
      localSample = null;
      profileSent = "";
      if (old.connection !== "idle") {
        invalidatePlaybackOperation();
        void window.api.player.pause();
        useStatusStore().state = "paused";
      }
      return;
    }
    if (
      latest.snapshot?.revision !== old.snapshot?.revision ||
      latest.snapshot?.playing !== old.snapshot?.playing
    ) {
      generation++;
      retryAt = 0;
      correctAfter = 0;
      localReady = null;
      localSample = null;
      if (applyingRevision !== latest.snapshot?.revision) invalidatePlaybackOperation();
    }
    pending = { state: latest, received: receivedAt, generation };
    void drain();
  };
  let gotEvent = false;
  const unsubscribe = window.api.together.onStatus((latest) => {
    gotEvent = true;
    receive(latest);
  });
  void window.api.together.status().then((latest) => {
    if (!gotEvent) receive(latest);
  });
  /** 界面重载时暂停共享计时，避免把加载过程算作共同听歌 */
  const unloading = (): void => {
    if (state.value.connection === "connected")
      void window.api.together.send({ type: "unavailable" }).catch(() => {});
  };
  window.addEventListener("beforeunload", unloading);
  const timer = setInterval(() => {
    if (document.visibilityState === "visible") now.value = Date.now();
  }, 1000);
  onScopeDispose(() => {
    window.removeEventListener("beforeunload", unloading);
    unsubscribe();
    clearInterval(timer);
    setTogetherControl(null);
  });
  /** 创建双人房间
   * @param address - 可选 VPN 或局域网 IP
   */
  const host = async (address?: string): Promise<void> => {
    playbackError.value = "";
    const profile = useAccountStore().profile;
    await window.api.together.host(profile?.nickname || "听友", address, profile?.avatarUrl);
  };
  /** 加入邀请码指定的房间
   * @param invite - 房间邀请码
   */
  const join = async (invite: string): Promise<void> => {
    playbackError.value = "";
    const profile = useAccountStore().profile;
    await window.api.together.join(invite, profile?.nickname || "听友", profile?.avatarUrl);
  };
  /** 退出房间，停止共享播放 */
  const leave = async (): Promise<void> => {
    await window.api.player.pause();
    await window.api.together.leave();
    playbackError.value = "";
  };
  return { chatOpen, state, elapsed, durationLabel, playbackError, command, host, join, leave };
});
