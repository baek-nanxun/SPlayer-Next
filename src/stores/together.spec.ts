import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia, disposePinia } from "pinia";
import { flushPromises } from "@vue/test-utils";
import type { TogetherStatus } from "@shared/types/together";
const mocks = vi.hoisted(() => ({
  queue: vi.fn(),
  apply: vi.fn().mockResolvedValue(undefined),
  invalidate: vi.fn(),
  send: vi.fn().mockResolvedValue(undefined),
  receive: null as ((state: TogetherStatus) => void) | null,
  host: vi.fn(),
  join: vi.fn(),
  status: vi.fn(),
  localTracks: [] as import("@shared/types/player").Track[],
  localStatus: {
    state: "paused",
    currentTrack: null as import("@shared/types/player").Track | null,
  },
}));
vi.mock("@/core/player", () => ({
  applyTogetherQueue: mocks.queue,
  applyTogetherSnapshot: mocks.apply,
  invalidatePlaybackOperation: mocks.invalidate,
}));
vi.mock("./account", () => ({
  useAccountStore: () => ({
    profile: { nickname: "听友", avatarUrl: "https://example.com/avatar.jpg" },
  }),
}));
vi.mock("./status", () => ({ useStatusStore: () => mocks.localStatus }));
vi.mock("./queue", () => ({
  queue: {
    get value() {
      return mocks.localTracks;
    },
  },
}));
vi.mock("@/composables/useToast", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));
import { useTogetherStore } from "./together";
let pinia: ReturnType<typeof createPinia>;
const track = { id: "one", source: "qqmusic" as const, title: "一", artists: [], duration: 100000 };
/** 构造共享播放状态
 * @param queueRevision - 队列版本
 * @param count - 歌曲数量
 */
const state = (queueRevision: number, count: number): TogetherStatus => ({
  connection: "connected",
  hosting: false,
  invite: "test",
  error: "",
  snapshot: {
    revision: 3,
    queueRevision,
    serverTime: 1000,
    position: 10000,
    playing: true,
    desiredPlaying: true,
    index: 0,
    tracks: Array.from({ length: count }, (_, i) => ({ ...track, id: String(i) })),
    members: [],
    elapsedMs: 0,
    counting: true,
    chat: [],
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.localTracks = [];
  mocks.localStatus.currentTrack = null;
  mocks.apply.mockReset().mockResolvedValue(undefined);
  mocks.status.mockResolvedValue({ success: true, data: { position: 10000, state: "playing" } });
  pinia = createPinia();
  setActivePinia(pinia);
  Object.assign(window, {
    api: {
      together: {
        onStatus: (cb: typeof mocks.receive) => {
          mocks.receive = cb;
          return () => {};
        },
        status: async () => ({
          connection: "idle",
          invite: "",
          hosting: false,
          error: "",
          snapshot: null,
        }),
        send: mocks.send,
        host: mocks.host,
        join: mocks.join,
      },
      player: {
        getStatus: mocks.status,
        pause: async () => ({ success: true }),
      },
    },
  });
});
afterEach(() => {
  disposePinia(pinia);
  vi.useRealTimers();
});
it("收到对方加歌立即更新完整列表，不重载当前曲或重复发送旧队列", async () => {
  useTogetherStore();
  await flushPromises();
  mocks.receive!(state(1, 2));
  await flushPromises();
  mocks.queue.mockClear();
  mocks.apply.mockClear();
  mocks.send.mockClear();
  mocks.receive!(state(2, 3));
  await flushPromises();
  expect(mocks.queue).toHaveBeenCalledOnce();
  expect(mocks.queue.mock.calls[0][0].tracks).toHaveLength(3);
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it("歌曲列表自动同步支持超过 200 首，发送时裁剪本地字段", async () => {
  const room = useTogetherStore();
  await flushPromises();
  mocks.receive!(state(1, 2));
  await flushPromises();
  mocks.send.mockClear();
  room.command({
    type: "queue",
    tracks: Array.from({ length: 274 }, (_, i) => ({
      ...track,
      id: String(i),
      path: "/private/file",
    })),
    index: 5,
  });
  const sent = mocks.send.mock.calls[0][0];
  expect(sent.command.tracks).toHaveLength(274);
  expect(sent.command.index).toBe(5);
  expect(sent.command.tracks[0]).not.toHaveProperty("path");
});
it("建房和加入时同步当前账号头像", async () => {
  const room = useTogetherStore();
  await flushPromises();
  await room.host("127.0.0.1");
  await room.join("invite");
  expect(mocks.host).toHaveBeenCalledWith("听友", "127.0.0.1", "https://example.com/avatar.jpg");
  expect(mocks.join).toHaveBeenCalledWith("invite", "听友", "https://example.com/avatar.jpg");
});

it("聊天红点只累计对方的新消息，重复快照不重计且打开后清除", async () => {
  const room = useTogetherStore();
  await flushPromises();
  const frame = state(1, 2);
  frame.memberId = "me";
  frame.snapshot!.chat = [{ id: 1, senderId: "other", name: "听友", text: "你好" }];
  mocks.receive!(frame);
  await flushPromises();
  expect(room.unreadChat).toBe(1);
  mocks.receive!(structuredClone(frame));
  expect(room.unreadChat).toBe(1);
  frame.snapshot!.chat.push({ id: 2, senderId: "me", name: "听友", text: "我发的" });
  mocks.receive!(structuredClone(frame));
  expect(room.unreadChat).toBe(1);
  room.chatOpen = true;
  expect(room.unreadChat).toBe(0);
  frame.snapshot!.chat.push({ id: 3, senderId: "other", name: "听友", text: "已打开" });
  mocks.receive!(structuredClone(frame));
  expect(room.unreadChat).toBe(0);
  room.chatOpen = false;
  frame.snapshot!.chat.push({ id: 4, senderId: "other", name: "听友", text: "新消息" });
  mocks.receive!(structuredClone(frame));
  expect(room.unreadChat).toBe(1);
  mocks.receive!({ ...frame, connection: "idle", snapshot: null });
  expect(room.unreadChat).toBe(0);
});

it("聊天保留 50 条时仍识别新消息，换房清除旧的未读状态", async () => {
  const room = useTogetherStore();
  await flushPromises();
  const frame = state(1, 2);
  frame.memberId = "me";
  frame.snapshot!.chat = Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    senderId: "other",
    name: "听友",
    text: "消息",
  }));
  mocks.receive!(frame);
  room.chatOpen = true;
  room.chatOpen = false;
  frame.snapshot!.chat = [
    ...frame.snapshot!.chat.slice(1),
    { id: 51, senderId: "other", name: "听友", text: "新消息" },
  ];
  mocks.receive!(structuredClone(frame));
  expect(room.unreadChat).toBe(1);
  mocks.receive!({ ...state(1, 2), invite: "another-room" });
  expect(room.unreadChat).toBe(0);
});

it("正常播放领先于晚到快照时不回退，也不发出暂停命令", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  useTogetherStore();
  await flushPromises();
  mocks.receive!(state(1, 2));
  await flushPromises();
  mocks.apply.mockClear();
  mocks.send.mockClear();
  vi.setSystemTime(Date.now() + 6000);
  mocks.status.mockResolvedValue({ success: true, data: { position: 20000, state: "playing" } });
  mocks.receive!(state(1, 2));
  await flushPromises();
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it("本机卡住仅上报缓冲并恢复本机，不发送共享暂停或回退", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  useTogetherStore();
  await flushPromises();
  mocks.receive!(state(1, 2));
  await flushPromises();
  mocks.apply.mockClear();
  mocks.send.mockClear();
  vi.setSystemTime(Date.now() + 6000);
  mocks.status.mockResolvedValue({ success: true, data: { position: 10000, state: "paused" } });
  const latest = state(1, 2);
  latest.snapshot!.position = 16000;
  mocks.receive!(latest);
  await flushPromises();
  expect(mocks.send).toHaveBeenCalledWith({ type: "unavailable" });
  expect(mocks.apply).toHaveBeenCalledOnce();
  expect(mocks.apply.mock.calls[0][0].position).toBeGreaterThanOrEqual(16000);
  expect(mocks.send.mock.calls.some(([m]) => m.type === "command")).toBe(false);
});
it("本机追赶失败后等待重试，健康听友不收到暂停", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const room = useTogetherStore();
  await flushPromises();
  mocks.receive!(state(1, 2));
  await flushPromises();
  mocks.apply.mockClear();
  mocks.send.mockClear();
  vi.setSystemTime(Date.now() + 6000);
  mocks.status.mockResolvedValue({ success: true, data: { position: 1000, state: "playing" } });
  mocks.apply.mockRejectedValueOnce(new Error("网络中断"));
  mocks.receive!(state(1, 2));
  await flushPromises();
  expect(room.playbackError).toBe("网络中断");
  expect(mocks.send).toHaveBeenCalledWith({ type: "unavailable" });
  mocks.receive!(state(1, 2));
  await flushPromises();
  expect(mocks.apply).toHaveBeenCalledOnce();
  vi.setSystemTime(Date.now() + 6000);
  mocks.receive!(state(1, 2));
  await flushPromises();
  expect(mocks.apply).toHaveBeenCalledTimes(2);
  expect(room.playbackError).toBe("");
  expect(mocks.send.mock.calls.some(([m]) => m.type === "command")).toBe(false);
});

it("持续缓冲时保留恢复间隔，避免每个心跳反复拖动本机", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  useTogetherStore();
  await flushPromises();
  mocks.receive!(state(1, 2));
  await flushPromises();
  mocks.apply.mockClear();
  mocks.send.mockClear();
  mocks.status.mockResolvedValue({ success: true, data: { position: 10000, state: "paused" } });
  vi.setSystemTime(Date.now() + 6000);
  mocks.receive!(state(1, 2));
  await flushPromises();
  expect(mocks.apply).toHaveBeenCalledOnce();
  for (let i = 0; i < 3; i++) {
    vi.setSystemTime(Date.now() + 6000);
    mocks.receive!(state(1, 2));
    await flushPromises();
  }
  expect(mocks.apply).toHaveBeenCalledOnce();
  vi.setSystemTime(Date.now() + 6000);
  mocks.receive!(state(1, 2));
  await flushPromises();
  expect(mocks.apply).toHaveBeenCalledTimes(2);
  expect(mocks.send.mock.calls.some(([m]) => m.type === "command")).toBe(false);
});

it("共享歌曲保留安全封面、专辑与版权信息，仍剔除本地路径", async () => {
  const room = useTogetherStore();
  await flushPromises();
  mocks.receive!(state(1, 2));
  await flushPromises();
  mocks.send.mockClear();
  room.command({
    type: "playTrack",
    track: {
      ...track,
      cover: "https://y.gtimg.cn/cover.jpg",
      album: {
        id: "album",
        name: "专辑",
        cover: "https://y.gtimg.cn/album.jpg",
        serverId: "private-server",
      },
      fee: 1,
    },
  });
  expect(mocks.send.mock.calls[0][0].command.track).toMatchObject({
    cover: "https://y.gtimg.cn/cover.jpg",
    album: { id: "album", name: "专辑" },
    fee: 1,
  });
  expect(mocks.send.mock.calls[0][0].command.track.album).not.toHaveProperty("serverId");
  mocks.send.mockClear();
  room.command({ type: "playTrack", track: { ...track, cover: "file:///private/cover" } });
  expect(mocks.send.mock.calls[0][0].command.track).not.toHaveProperty("cover");
});

it("新建网易云官方空房间时点击当前歌曲，先共享完整网易云列表", async () => {
  const room = useTogetherStore();
  await flushPromises();
  const empty = state(0, 0);
  empty.mode = "netease";
  mocks.localTracks = ["11", "22"].map((id) => ({ ...track, id, source: "netease" }));
  mocks.localStatus.currentTrack = mocks.localTracks[1];
  mocks.receive!(empty);
  await flushPromises();
  mocks.send.mockClear();
  room.command({ type: "play" });
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith({
    type: "command",
    command: {
      type: "queue",
      tracks: mocks.localTracks,
      index: 1,
    },
  });
});

it("官方轮询暂时超时保留本机播放，恢复后不重新加载相同版本", async () => {
  const room = useTogetherStore();
  await flushPromises();
  const active = state(1, 2);
  active.mode = "netease";
  mocks.receive!(active);
  await flushPromises();
  mocks.apply.mockClear();
  mocks.invalidate.mockClear();
  const pause = vi.spyOn(window.api.player, "pause");
  mocks.receive!({ ...active, connection: "reconnecting", error: "同步超时" });
  expect(room.state.error).toBe("同步超时");
  expect(pause).not.toHaveBeenCalled();
  expect(mocks.invalidate).not.toHaveBeenCalled();
  mocks.receive!(active);
  await flushPromises();
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(mocks.send).toHaveBeenCalledWith({ type: "ready", revision: active.snapshot!.revision });
});
