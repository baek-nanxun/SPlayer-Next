import { useAccountStore } from "./account";
import { useMediaStore } from "./media";
import { useStatusStore } from "./status";
import { queue as playerQueue } from "./queue";
import { setTogetherControl } from "@/services/togetherBridge";
import {
  applyTogetherQueue,
  applyTogetherSnapshot,
  invalidatePlaybackOperation,
  normalizeTogetherPlayback,
} from "@/core/player";
import { toast } from "@/composables/useToast";
import {
  TOGETHER_MAX_TRACKS,
  TOGETHER_MAX_PAYLOAD,
  isShareableTogetherTrack,
} from "@shared/types/together";
import type {
  TogetherCommand,
  TogetherInitialState,
  TogetherStatus,
  TogetherTrack,
} from "@shared/types/together";

/**
 * 只发送必要歌曲资料，完整歌单也不包含本地路径或大封面
 * @param track - 本地歌曲资料
 * @returns 裁剪后的安全曲目资料
 */
const compactTrack = (track: TogetherTrack): TogetherTrack => {
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
  const unreadChat = ref(0);
  let lastChatId = 0;
  watch(
    chatOpen,
    (open) => {
      if (open) unreadChat.value = 0;
    },
    { flush: "sync" },
  );
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
  let lastPlaybackError = "";
  let lastErrorAt = 0;
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
  /**
   * 提示不可共享曲目的原因
   * @param sample - 被拒绝的曲目列表
   */
  const warnInvalidTracks = (sample: ReadonlyArray<{ source?: string } | undefined>): void => {
    if (state.value.mode === "qqmusic" && sample.some((t) => t?.source !== "qqmusic")) {
      toast.warning("QQ 官方一起听仅支持 QQ 音乐歌曲，跨平台请使用自建房间");
      return;
    }
    if (state.value.mode === "netease" && sample.some((t) => t?.source !== "netease")) {
      toast.warning("网易云官方一起听仅支持网易云歌曲，跨平台请使用自建房间");
      return;
    }
    if (sample.some((t) => !["qqmusic", "netease"].includes(t?.source || ""))) {
      toast.warning("一起听请使用 QQ 音乐或网易云在线歌曲");
      return;
    }
    toast.warning("所选歌曲缺少有效在线信息，无法同步到一起听");
  };
  /**
   * 围绕目标曲目裁剪有界在线队列
   * @param list - 已过滤的在线曲目
   * @param index - 目标曲目索引
   * @param limit - 队列上限
   * @returns 裁剪后的在线曲目窗口与目标索引
   */
  const sliceAround = (
    list: TogetherTrack[],
    index: number,
    limit: number,
  ): { tracks: TogetherTrack[]; index: number } => {
    const safeIndex = Math.max(0, Math.min(index, list.length - 1));
    if (list.length <= limit) return { tracks: list, index: safeIndex };
    const start = Math.max(0, Math.min(safeIndex - Math.floor(limit / 2), list.length - limit));
    return { tracks: list.slice(start, start + limit), index: safeIndex - start };
  };
  /**
   * 提取本机实际已加载曲目与可共享在线队列，供建房无缝继承
   * @param mode - 目标房间模式
   * @param limit - 最大曲目数
   * @returns 房间初始同步状态，无可共享曲目时返回 undefined
   */
  const collectInitialState = async (
    mode?: TogetherStatus["mode"],
    limit = TOGETHER_MAX_TRACKS,
  ): Promise<TogetherInitialState | undefined> => {
    const status = useStatusStore() as ReturnType<typeof useStatusStore> & {
      position?: number;
      fmMode?: boolean;
      shuffleMode?: "off" | "on";
      repeatMode?: "list" | "one";
    };
    const loaded = useMediaStore().track;
    const shareable = status.fmMode
      ? []
      : playerQueue.value.filter((t) => isShareableTogetherTrack(t, mode));
    if (loaded) {
      if (!isShareableTogetherTrack(loaded, mode)) return undefined;
      const found = shareable.findIndex((t) => t.id === loaded.id && t.source === loaded.source);
      const base = found >= 0 ? shareable : [loaded];
      const sliced = sliceAround(base, found >= 0 ? found : 0, limit);
      const live = await window.api.player?.getStatus?.().catch(() => null);
      const rawPos = live?.success && live.data ? live.data.position : (status.position ?? 0);
      const playing =
        live?.success && live.data ? live.data.state === "playing" : status.state === "playing";
      const target = sliced.tracks[sliced.index];
      return {
        tracks: sliced.tracks.map(compactTrack),
        index: sliced.index,
        position: Math.min(target.duration, Math.max(0, Math.round(rawPos))),
        playing,
        shuffleMode: status.shuffleMode === "on" ? "on" : "off",
        repeatMode: status.repeatMode === "one" ? "one" : "list",
      };
    }
    const fallback = !status.fmMode ? status.currentTrack : null;
    if (isShareableTogetherTrack(fallback, mode)) {
      const found = shareable.findIndex(
        (t) => t.id === fallback.id && t.source === fallback.source,
      );
      const base = found >= 0 ? shareable : [fallback];
      const sliced = sliceAround(base, found >= 0 ? found : 0, limit);
      const target = sliced.tracks[sliced.index];
      return {
        tracks: sliced.tracks.map(compactTrack),
        index: sliced.index,
        position: Math.min(target.duration, Math.max(0, Math.round(status.position ?? 0))),
        playing: false,
        shuffleMode: status.shuffleMode === "on" ? "on" : "off",
        repeatMode: status.repeatMode === "one" ? "one" : "list",
      };
    }
    if (!mode && shareable.length > 0) {
      const sliced = sliceAround(shareable, 0, limit);
      return {
        tracks: sliced.tracks.map(compactTrack),
        index: sliced.index,
        position: 0,
        playing: false,
        shuffleMode: status.shuffleMode === "on" ? "on" : "off",
        repeatMode: status.repeatMode === "one" ? "one" : "list",
      };
    }
    return undefined;
  };
  /** 发送同权控制操作
   * @param command - 双方均可发起的操作
   */
  const command = (command: TogetherCommand): void => {
    if (state.value.connection !== "connected") {
      toast.warning("房间连接中，请稍候");
      return;
    }
    const maxLimit = state.value.mode === "qqmusic" ? 1000 : TOGETHER_MAX_TRACKS;
    // 房间为空时点击播放或切歌，自动将本机当前在线队列同步进房间
    if (
      (command.type === "play" || command.type === "next" || command.type === "prev") &&
      !state.value.snapshot?.tracks.length
    ) {
      const status = useStatusStore() as ReturnType<typeof useStatusStore> & { fmMode?: boolean };
      const active = useMediaStore().track ?? (!status.fmMode ? status.currentTrack : null);
      const shareable = status.fmMode
        ? []
        : playerQueue.value.filter((t) => isShareableTogetherTrack(t, state.value.mode));
      const found = active
        ? shareable.findIndex((t) => t.id === active.id && t.source === active.source)
        : -1;
      const list =
        found >= 0
          ? shareable
          : isShareableTogetherTrack(active, state.value.mode)
            ? [active]
            : shareable;
      if (!list.length) {
        if (active) warnInvalidTracks([active]);
        else toast.warning("请先选择一个在线歌单或歌曲，开始一起听");
        return;
      }
      let baseIndex = found >= 0 ? found : 0;
      if (command.type === "next" && list.length > 1) baseIndex = (baseIndex + 1) % list.length;
      if (command.type === "prev" && list.length > 1)
        baseIndex = (baseIndex - 1 + list.length) % list.length;
      const sliced = sliceAround(list, baseIndex, maxLimit);
      command = { type: "queue", tracks: sliced.tracks, index: sliced.index };
    }
    if (command.type === "playTrack") {
      if (!isShareableTogetherTrack(command.track, state.value.mode)) {
        warnInvalidTracks([command.track]);
        return;
      }
    } else if (command.type === "queue") {
      const chosen = command.tracks[command.index];
      if (!isShareableTogetherTrack(chosen, state.value.mode)) {
        warnInvalidTracks(chosen ? [chosen] : command.tracks);
        return;
      }
      const shareable: TogetherTrack[] = [];
      let mappedIndex = 0;
      for (const [i, item] of command.tracks.entries()) {
        if (!isShareableTogetherTrack(item, state.value.mode)) continue;
        if (i === command.index) mappedIndex = shareable.length;
        shareable.push(item);
      }
      const sliced = sliceAround(shareable, mappedIndex, maxLimit);
      command = { type: "queue", tracks: sliced.tracks, index: sliced.index };
    } else if (command.type === "enqueue") {
      const shareable = command.tracks
        .filter((item) => isShareableTogetherTrack(item, state.value.mode))
        .slice(0, maxLimit);
      if (!shareable.length) {
        warnInvalidTracks(command.tracks);
        return;
      }
      command = { ...command, tracks: shareable };
    }
    const outgoing =
      command.type === "queue" || command.type === "enqueue"
        ? { ...command, tracks: command.tracks.map(compactTrack) }
        : command.type === "playTrack"
          ? { ...command, track: compactTrack(command.track) }
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
          const target = snapshot.tracks[snapshot.index];
          const localStatus = useStatusStore() as ReturnType<typeof useStatusStore> & {
            currentSource?: string | null;
          };
          const loaded = useMediaStore().track;
          let seamlessHostSync = false;
          if (
            applied === "" &&
            job.state.hosting &&
            target &&
            loaded?.id === target.id &&
            loaded?.source === target.source &&
            Boolean(localStatus.currentSource) &&
            (localStatus.state === "playing") === snapshot.playing
          ) {
            const live = await window.api.player?.getStatus?.().catch(() => null);
            if (!current()) continue;
            if (
              live?.success &&
              live.data &&
              (live.data.state === "playing") === snapshot.playing &&
              Math.abs(live.data.position - position) < 300
            ) {
              await normalizeTogetherPlayback();
              if (!current()) continue;
              seamlessHostSync = true;
            }
          }
          if (!seamlessHostSync) {
            await applyTogetherSnapshot({ ...snapshot, position }, current);
            if (!current()) continue;
          }
          applied = key;
          if (playbackError.value)
            void window.api.together
              .send({ type: "diagnostic", event: "playback-recovered" })
              .catch(() => {});
          playbackError.value = "";
          lastPlaybackError = "";
          localReady = true;
          localSample = null;
          await window.api.together
            .send({ type: "ready", revision: snapshot.revision })
            .catch(() => {});
        } catch (error) {
          if (!current()) continue;
          playbackError.value = error instanceof Error ? error.message : "无法同步歌曲";
          if (playbackError.value !== lastPlaybackError || Date.now() - lastErrorAt >= 60000) {
            lastPlaybackError = playbackError.value;
            lastErrorAt = Date.now();
            void window.api.together
              .send({ type: "diagnostic", event: "playback-error", error: playbackError.value })
              .catch(() => {});
          }
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
  /** 接收房间状态并仅在退出有效房间连接时暂停
   * @param latest - 主进程连接状态
   */
  const receive = (latest: TogetherStatus): void => {
    const old = state.value;
    const hadActiveRoom =
      old.connection === "connected" || (old.connection === "reconnecting" && !!old.snapshot);
    const hasActiveRoom =
      latest.connection === "connected" ||
      (latest.connection === "reconnecting" && !!latest.snapshot);
    if (latest.connection === "idle") {
      playbackError.value = "";
      lastPlaybackError = "";
      lastErrorAt = 0;
    }
    if (latest.error && latest.error !== old.error && latest.connection !== "reconnecting") {
      toast.warning(latest.error);
    }
    if (latest.invite !== old.invite || latest.connection === "idle") {
      lastChatId = 0;
      unreadChat.value = 0;
      chatOpen.value = false;
    }
    const chat = latest.snapshot?.chat ?? [];
    if (!chatOpen.value) {
      unreadChat.value = Math.min(
        99,
        unreadChat.value +
          chat.filter(
            (item) => item.id > lastChatId && (!item.senderId || item.senderId !== latest.memberId),
          ).length,
      );
    }
    lastChatId = Math.max(lastChatId, ...chat.map((item) => item.id));
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
    setTogetherControl(hasActiveRoom ? command : null);
    if (latest.connection === "reconnecting" && latest.snapshot) {
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
      if (hadActiveRoom) {
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
  /**
   * 创建双人自建房间，自动继承当前在线歌曲与播放状态
   * @param address - 可选 VPN 或局域网 IP
   * @returns 生成的房间邀请码
   */
  const host = async (address?: string): Promise<string> => {
    playbackError.value = "";
    const profile = useAccountStore().profile;
    const initial = await collectInitialState();
    const nickname = profile?.nickname || "听友";
    const invite = initial
      ? await window.api.together.host(nickname, address, profile?.avatarUrl, initial)
      : await window.api.together.host(nickname, address, profile?.avatarUrl);
    if (invite && !state.value.invite) {
      state.value = { ...state.value, invite };
    }
    return invite;
  };
  /**
   * 创建 QQ 音乐官方一起听房间，若正在听 QQ 音乐则直接携带当前歌单与状态
   * @returns 房间创建完成
   */
  const hostQQMusic = async (): Promise<void> => {
    playbackError.value = "";
    const status = useStatusStore() as ReturnType<typeof useStatusStore> & { fmMode?: boolean };
    const active = useMediaStore().track ?? (!status.fmMode ? status.currentTrack : null);
    const initial =
      active?.source === "qqmusic" ? await collectInitialState("qqmusic", 1000) : undefined;
    if (initial?.tracks.length) {
      try {
        await window.api.together.hostQQMusic(
          initial.tracks,
          initial.index,
          initial.position ?? 0,
          initial.playing ?? false,
        );
        return;
      } catch (error) {
        if (!String(error).includes("身份解析失败")) throw error;
      }
    }
    await window.api.together.hostQQMusic([], 0, 0);
  };
  /**
   * 创建网易云官方一起听房间，建房阶段原子写入初始队列、进度与暂停或播放态
   * @returns 房间创建完成
   */
  const hostNetease = async (): Promise<void> => {
    playbackError.value = "";
    const status = useStatusStore() as ReturnType<typeof useStatusStore> & { fmMode?: boolean };
    const active = useMediaStore().track ?? (!status.fmMode ? status.currentTrack : null);
    const initial =
      active?.source === "netease"
        ? await collectInitialState("netease", TOGETHER_MAX_TRACKS)
        : undefined;
    if (initial?.tracks.length) {
      await window.api.together.hostNetease(initial);
      return;
    }
    await window.api.together.hostNetease();
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
    void window.api.player.pause().catch(() => {});
    try {
      await window.api.together.leave();
    } catch (error) {
      toast.warning(String(error));
    } finally {
      playbackError.value = "";
    }
  };
  return {
    chatOpen,
    unreadChat,
    state,
    elapsed,
    durationLabel,
    playbackError,
    command,
    host,
    hostQQMusic,
    hostNetease,
    join,
    leave,
  };
});
