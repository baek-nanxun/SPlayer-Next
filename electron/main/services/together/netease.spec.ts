import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { NeteaseTogether, parseNeteaseInvite, type OfficialApi } from "./netease";
import type { TogetherStatus } from "../../../../shared/types/together";
const invite =
  "https://st.music.163.com/listen-together/share/index.html?roomId=room_123&inviterId=1";
const instances: NeteaseTogether[] = [];
/** 构造双端共享的官方响应，不发真实网络请求 */
const setup = () => {
  const state = {
    ids: ["11", "22"],
    version: 1,
    inRoom: true,
    command: {
      targetSongId: "11",
      progress: 10000,
      playStatus: "PLAY",
      serverSeq: Date.now(),
      clientSeq: 1,
    },
  };
  const roomInfo = {
    roomId: "room_123",
    creatorId: 1,
    roomUsers: [
      { userId: 1, nickname: "官方听友", avatarUrl: "https://example.com/1.jpg" },
      { userId: 2, nickname: "SPlayer听友", avatarUrl: "https://example.com/2.jpg" },
    ],
  };
  const api = vi.fn<OfficialApi>(async (name, p = {}) => {
    if (name === "listentogether_status")
      return { code: 200, data: { inRoom: state.inRoom, roomInfo } };
    if (name === "listentogether_room_create" || name === "listentogether_accept") {
      state.inRoom = true;
      return { code: 200, data: { roomInfo } };
    }
    if (name === "listentogether_sync_playlist_get")
      return {
        code: 200,
        data: {
          playCommand: { ...state.command },
          playlist: {
            displayList: { result: [...state.ids] },
            version: [{ userId: 1, version: state.version }],
          },
        },
      };
    if (name === "song_detail")
      return {
        code: 200,
        songs: String(p.ids)
          .split(",")
          .map((id) => ({
            id: Number(id),
            name: `歌曲${id}`,
            dt: 300000,
            ar: [{ id: 1, name: "歌手" }],
          })),
      };
    if (name === "listentogether_heatbeat")
      return { code: 200, data: { result: true, time: Date.now() } };
    if (name === "user_account") return { code: 200, profile: { userId: 2 } };
    if (name === "listentogether_sync_list_command") {
      state.ids = [...(p.displayList as string[])];
      state.version = Number(p.version);
      return { code: 200, data: { result: true } };
    }
    if (name === "listentogether_play_command") {
      state.command = {
        targetSongId: String(p.targetSongId),
        progress: Number(p.progress),
        playStatus: String(p.playStatus),
        serverSeq: Date.now() + 1,
        clientSeq: Number(p.clientSeq),
      };
      return { code: 200, data: { result: true } };
    }
    if (name === "listentogether_end") {
      state.inRoom = false;
      return { code: 200, data: { success: true } };
    }
    throw new Error("未预期的接口");
  });
  const frames: TogetherStatus[] = [];
  const client = new NeteaseTogether(api, (frame) => frames.push(frame));
  instances.push(client);
  return { state, api, client, frames };
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T04:00:00Z"));
});
afterEach(() => {
  for (const client of instances.splice(0)) client.stop();
  vi.useRealTimers();
});
it("只解析官方分享页，拒绝任意网站、伪造域名和缺失字段", () => {
  expect(parseNeteaseInvite(`我的耳机分你一半 ${invite} (@网易云音乐)`)).toMatchObject({
    roomId: "room_123",
    inviterId: "1",
  });
  for (const value of [
    invite.replace("st.music.163.com", "example.com"),
    invite.replace("st.music.163.com", "st.music.163.com.evil.com"),
    invite.replace("https:", "http:"),
    "https://st.music.163.com/",
    invite.replace("inviterId=1", "inviterId=x"),
  ])
    expect(() => parseNeteaseInvite(value)).toThrow();
});
it("加入已有官方房间读到双方头像和完整列表，查询不回传控制", async () => {
  const { client, frames, api } = setup();
  await client.start(invite);
  expect(frames.at(-1)).toMatchObject({
    mode: "netease",
    connection: "connected",
    snapshot: { position: 10000, playing: true },
  });
  expect(frames.at(-1)!.snapshot!.tracks).toHaveLength(2);
  expect(frames.at(-1)!.snapshot!.members.every((m) => m.avatar)).toBe(true);
  expect(
    api.mock.calls.some(
      ([name]) => name === "listentogether_play_command" || name === "listentogether_accept",
    ),
  ).toBe(false);
});
it("本机缓冲只改变准备状态，健康听友不收到共享暂停", async () => {
  const { client, frames, api } = setup();
  await client.start(invite);
  await client.send({ type: "ready", revision: frames.at(-1)!.snapshot!.revision });
  await vi.advanceTimersByTimeAsync(2100);
  expect(frames.at(-1)!.snapshot!.counting).toBe(true);
  await client.send({ type: "unavailable" });
  await vi.advanceTimersByTimeAsync(2100);
  expect(frames.at(-1)!.snapshot!.counting).toBe(false);
  expect(frames.at(-1)!.snapshot!.playing).toBe(true);
  expect(api.mock.calls.some(([name]) => name === "listentogether_play_command")).toBe(false);
});
it("官方远端暂停和切歌刷新版本，但普通轮询不反复重载歌曲", async () => {
  const { client, state, frames } = setup();
  await client.start(invite);
  const revision = frames.at(-1)!.snapshot!.revision;
  await vi.advanceTimersByTimeAsync(2100);
  expect(frames.at(-1)!.snapshot!.revision).toBe(revision);
  state.command = { ...state.command, playStatus: "PAUSE", progress: 12345, serverSeq: Date.now() };
  await vi.advanceTimersByTimeAsync(2100);
  expect(frames.at(-1)!.snapshot).toMatchObject({
    revision: revision + 1,
    playing: false,
    position: 12345,
  });
  state.command = {
    ...state.command,
    targetSongId: "22",
    progress: 0,
    playStatus: "PLAY",
    serverSeq: Date.now(),
  };
  await vi.advanceTimersByTimeAsync(2100);
  expect(frames.at(-1)!.snapshot).toMatchObject({ index: 1, playing: true });
});
it("SPlayer暂停与拖动使用官方控制，而不是独立的自建房间状态", async () => {
  const { client, api, frames } = setup();
  await client.start(invite);
  await client.send({ type: "command", command: { type: "pause" } });
  expect(frames.at(-1)!.snapshot!.playing).toBe(false);
  await client.send({ type: "command", command: { type: "seek", position: 56000 } });
  expect(
    api.mock.calls.filter(([name]) => name === "listentogether_play_command").at(-1)![1],
  ).toMatchObject({
    commandType: "SEEK",
    progress: 56000,
    playStatus: "PAUSE",
    targetSongId: "11",
  });
});
it("加歌保留当前播放，不发新的 GOTO，切歌保留整个列表", async () => {
  const { client, api, frames } = setup();
  await client.start(invite);
  await client.send({
    type: "command",
    command: {
      type: "enqueue",
      position: "end",
      tracks: [{ id: "33", source: "netease", title: "三", duration: 300000, artists: [] }],
    },
  });
  expect(frames.at(-1)!.snapshot!.tracks).toHaveLength(3);
  expect(api.mock.calls.some(([name]) => name === "listentogether_play_command")).toBe(false);
  await client.send({ type: "command", command: { type: "next" } });
  expect(frames.at(-1)!.snapshot).toMatchObject({ index: 1 });
  expect(frames.at(-1)!.snapshot!.tracks).toHaveLength(3);
});
it("拒绝 QQ 曲目且不覆盖官方队列", async () => {
  const { client, api } = setup();
  await client.start(invite);
  await expect(
    client.send({
      type: "command",
      command: {
        type: "queue",
        index: 0,
        tracks: [{ id: "qqMID", source: "qqmusic", title: "QQ", duration: 300000, artists: [] }],
      },
    }),
  ).rejects.toThrow("仅支持");
  expect(api.mock.calls.some(([name]) => name === "listentogether_sync_list_command")).toBe(false);
});
it("结束的房间停止轮询，不擅自重新建房", async () => {
  const { client, state, frames, api } = setup();
  await client.start(invite);
  state.inRoom = false;
  await vi.advanceTimersByTimeAsync(13000);
  expect(frames.at(-1)!.connection).toBe("idle");
  const count = api.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30000);
  expect(api).toHaveBeenCalledTimes(count);
});
it("停止本机测试不结束对方房间，等待请求不产生迟到控制", async () => {
  const { client, api } = setup();
  await client.start(invite);
  client.stop();
  await client.send({ type: "command", command: { type: "pause" } });
  await flushPromises();
  expect(
    api.mock.calls.some(
      ([name]) => name === "listentogether_end" || name === "listentogether_play_command",
    ),
  ).toBe(false);
});

it("主动结束才调用官方退房，普通停止不触碰远端", async () => {
  const { client, api, frames } = setup();
  await client.start(invite);
  await client.leave();
  expect(api.mock.calls.filter(([name]) => name === "listentogether_end")).toHaveLength(1);
  expect(frames.at(-1)!.connection).toBe("idle");
});
it("已有其他官方房间时不擅自退出或加入", async () => {
  const { client, api } = setup();
  await expect(client.start(invite.replace("room_123", "another_room"))).rejects.toThrow(
    "另一个官方房间",
  );
  expect(
    api.mock.calls.some(
      ([name]) => name === "listentogether_end" || name === "listentogether_accept",
    ),
  ).toBe(false);
});
it("建房返回可供官方客户端加入的分享链接", async () => {
  const { client, state, frames } = setup();
  state.inRoom = false;
  await client.start();
  expect(parseNeteaseInvite(frames.at(-1)!.invite)).toMatchObject({
    roomId: "room_123",
    inviterId: "1",
  });
  expect(frames.at(-1)!.hosting).toBe(true);
});

it("官方查询中断时冻结本机计时，不发送暂停给另一端", async () => {
  const { client, api, frames } = setup();
  await client.start(invite);
  await client.send({ type: "ready", revision: frames.at(-1)!.snapshot!.revision });
  await vi.advanceTimersByTimeAsync(2100);
  expect(frames.at(-1)!.snapshot!.counting).toBe(true);
  const implementation = api.getMockImplementation()!;
  api.mockImplementation(async (name, params) => {
    if (name === "listentogether_sync_playlist_get") throw new Error("网络中断");
    return implementation(name, params);
  });
  await vi.advanceTimersByTimeAsync(2100);
  const frame = frames.at(-1)!;
  expect(frame.connection).toBe("reconnecting");
  expect(frame.snapshot!.counting).toBe(false);
  const elapsed = frame.snapshot!.elapsedMs;
  await vi.advanceTimersByTimeAsync(12000);
  expect(frames.at(-1)!.snapshot!.elapsedMs).toBe(elapsed);
  expect(api.mock.calls.some(([name]) => name === "listentogether_play_command")).toBe(false);
});

it("新建的空房间暂停不报QQ曲目错误，直接选择网易云歌曲可开始同步", async () => {
  const { client, state, frames, api } = setup();
  state.ids = [];
  state.command.targetSongId = "";
  state.command.playStatus = "PAUSE";
  await client.start(invite);
  await client.send({ type: "command", command: { type: "pause" } });
  expect(api.mock.calls.some(([name]) => name === "listentogether_play_command")).toBe(false);
  await expect(client.send({ type: "command", command: { type: "play" } })).rejects.toThrow(
    "还没有歌曲",
  );
  await client.send({
    type: "command",
    command: {
      type: "playTrack",
      track: {
        id: "33",
        source: "netease",
        title: "选择的歌",
        artists: [],
        duration: 300000,
      },
    },
  });
  expect(frames.at(-1)!.snapshot!.tracks.map((t) => t.id)).toEqual(["33"]);
  expect(frames.at(-1)!.snapshot!.playing).toBe(true);
});

it("只读轮询遇到一次超时会恢复，控制写入超时不自动重复", async () => {
  const { client, api, frames } = setup();
  await client.start(invite);
  const implementation = api.getMockImplementation()!;
  let failRead = true;
  api.mockImplementation(async (name, params) => {
    if (name === "listentogether_sync_playlist_get" && failRead) {
      failRead = false;
      throw new Error("netease 502: timeout");
    }
    if (name === "listentogether_play_command") throw new Error("netease 502: timeout");
    return implementation(name, params);
  });
  await vi.advanceTimersByTimeAsync(2100);
  expect(frames.at(-1)!.connection).toBe("connected");
  await expect(client.send({ type: "command", command: { type: "pause" } })).rejects.toThrow(
    "timeout",
  );
  expect(api.mock.calls.filter(([name]) => name === "listentogether_play_command")).toHaveLength(1);
});

it("两份SPlayer共用官方房间时，任一端点歌、暂停与继续都会传给另一端", async () => {
  const { client, api, state, frames } = setup();
  const peerFrames: TogetherStatus[] = [];
  const peer = new NeteaseTogether(api, (frame) => peerFrames.push(frame));
  instances.push(peer);
  state.inRoom = false;
  state.ids = [];
  state.command.targetSongId = "";
  state.command.playStatus = "PAUSE";
  await client.start();
  await peer.start(invite);
  await client.send({
    type: "command",
    command: {
      type: "playTrack",
      track: {
        id: "33",
        source: "netease",
        title: "网易云单曲",
        duration: 300000,
        artists: [],
      },
    },
  });
  await vi.advanceTimersByTimeAsync(2100);
  expect(peerFrames.at(-1)!.snapshot).toMatchObject({ playing: true, tracks: [{ id: "33" }] });
  await peer.send({ type: "command", command: { type: "pause" } });
  await vi.advanceTimersByTimeAsync(2100);
  expect(frames.at(-1)!.snapshot!.playing).toBe(false);
  await client.send({ type: "command", command: { type: "play" } });
  await vi.advanceTimersByTimeAsync(2100);
  expect(peerFrames.at(-1)!.snapshot!.playing).toBe(true);
  expect(api.mock.calls.filter(([name]) => name === "listentogether_play_command")).toHaveLength(3);
});
