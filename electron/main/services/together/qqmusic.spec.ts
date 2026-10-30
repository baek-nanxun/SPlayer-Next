import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QQMusicTogether } from "./qqmusic";
import type { createQQTogetherApi } from "../../apis/qqmusic/core/together";
import type {
  QQTogetherHeartbeat,
  QQTogetherSong,
} from "../../../../shared/types/qqmusic-together";
import type { TogetherStatus } from "../../../../shared/types/together";
const invite = "https://i.y.qq.com/n2/m/share/listen_together/index.html?showid=LUGC123&songid=11";
const instances: QQMusicTogether[] = [];
/** 构造可回读的 QQ 官方协议状态，所有测试均不发真实请求 */
const setup = () => {
  const state: QQTogetherHeartbeat = {
    songInfo: {
      playingSongInfo: { songID: 11, songType: 1, songIndex: 0, title: "一" },
      playStatus: 1,
      songOffset: 10000,
      songPlayVersion: 1,
    },
    mediaVersion: 1,
    users: [
      { encryptUin: "one", nick: "听友一", headUrl: "https://example.com/a.jpg" },
      { encryptUin: "two", nick: "听友二", headUrl: "https://example.com/b.jpg" },
    ],
  };
  let list: QQTogetherSong[] = [11, 22].map((id, i) => ({
    songID: id,
    songType: 1,
    songIndex: i,
    title: String(id),
  }));
  const api = {
    join: vi.fn(async () => ({})),
    heartbeat: vi.fn(async () => structuredClone(state)),
    playlist: vi.fn(async () => [...list]),
    tracks: vi.fn(async (ids: number[]) =>
      ids.map((id) => ({
        id,
        type: 1,
        mid: `MID${id}`,
        title: `歌曲${id}`,
        interval: 300,
        singer: [{ name: "歌手" }],
      })),
    ),
    resolve: vi.fn(),
    create: vi.fn<ReturnType<typeof createQQTogetherApi>["create"]>(async () => ({
      entryInfo: { roomInfo: { showID: "LUGC123" } },
    })),
    quit: vi.fn(async () => ({})),
    control: vi.fn(async (_room, cmd, queue, index, position) => {
      if (cmd === 1) {
        list = queue;
        state.mediaVersion!++;
        return {};
      }
      state.songInfo.playingSongInfo = queue[index];
      state.songInfo.songOffset = cmd === 4 ? 0 : position;
      if (cmd === 2 || cmd === 4) state.songInfo.playStatus = 1;
      if (cmd === 3) state.songInfo.playStatus = 0;
      state.songInfo.songPlayVersion!++;
      return {};
    }),
  } satisfies ReturnType<typeof createQQTogetherApi>;
  const frames: TogetherStatus[] = [];
  const client = new QQMusicTogether(api, (frame) => frames.push(frame));
  instances.push(client);
  return {
    client,
    api,
    state,
    frames,
    empty: () => {
      list = [];
      state.songInfo = { playStatus: 0 };
    },
  };
};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  instances.splice(0).forEach((x) => x.stop());
  vi.useRealTimers();
});
it("官方加入后保留完整列表、MID 与数字 ID，并显示双方头像", async () => {
  const { client, frames, api } = setup();
  await client.start(invite);
  expect(frames.at(-1)).toMatchObject({
    mode: "qqmusic",
    connection: "connected",
    snapshot: { position: 10000, playing: true },
  });
  expect(frames.at(-1)!.snapshot!.tracks.map((t) => [t.id, t.extId])).toEqual([
    ["MID11", "11"],
    ["MID22", "22"],
  ]);
  expect(frames.at(-1)!.snapshot!.members.every((m) => m.avatar)).toBe(true);
  expect(api.control).not.toHaveBeenCalled();
});
it("普通心跳只推进进度，不改变播放版本或反复拉取整个歌单", async () => {
  const { client, frames, api, state } = setup();
  await client.start(invite);
  const revision = frames.at(-1)!.snapshot!.revision;
  state.songInfo.songOffset = 16000;
  await vi.advanceTimersByTimeAsync(2100);
  expect(frames.at(-1)!.snapshot).toMatchObject({ position: 16000, revision });
  expect(api.playlist).toHaveBeenCalledOnce();
  expect(api.control).not.toHaveBeenCalled();
});
it("QQ App 的暂停与切歌改变播放版本，队列仍完整", async () => {
  const { client, frames, state } = setup();
  await client.start(invite);
  state.songInfo.playStatus = 0;
  state.songInfo.songPlayVersion!++;
  await vi.advanceTimersByTimeAsync(2100);
  expect(frames.at(-1)!.snapshot!.playing).toBe(false);
  state.songInfo.playingSongInfo = { songID: 22, songType: 1, songIndex: 1, title: "二" };
  state.songInfo.playStatus = 1;
  state.songInfo.songPlayVersion!++;
  await vi.advanceTimersByTimeAsync(2100);
  expect(frames.at(-1)!.snapshot).toMatchObject({ index: 1, playing: true });
  expect(frames.at(-1)!.snapshot!.tracks).toHaveLength(2);
});
it("弱网准备状态不发共享暂停，查询断网后冻结本机计时", async () => {
  const { client, frames, api } = setup();
  await client.start(invite);
  await client.send({ type: "ready", revision: frames.at(-1)!.snapshot!.revision });
  await vi.advanceTimersByTimeAsync(2100);
  expect(frames.at(-1)!.snapshot!.counting).toBe(true);
  await client.send({ type: "unavailable" });
  await vi.advanceTimersByTimeAsync(2100);
  expect(frames.at(-1)!.snapshot).toMatchObject({ playing: true, counting: false });
  api.heartbeat.mockRejectedValue(new Error("网络断开"));
  await vi.advanceTimersByTimeAsync(2100);
  expect(frames.at(-1)).toMatchObject({
    connection: "reconnecting",
    snapshot: { counting: false },
  });
  expect(api.control).not.toHaveBeenCalled();
});
it("加歌只同步队列，不追加切歌或回退当前播放", async () => {
  const { client, frames, api } = setup();
  await client.start(invite);
  const revision = frames.at(-1)!.snapshot!.revision;
  await client.send({
    type: "command",
    command: {
      type: "enqueue",
      position: "end",
      tracks: [
        { source: "qqmusic", id: "MID33", extId: "33", duration: 300000, title: "三", artists: [] },
      ],
    },
  });
  expect(api.control).toHaveBeenCalledOnce();
  expect(api.control.mock.calls[0][1]).toBe(1);
  expect(frames.at(-1)!.snapshot!.tracks).toHaveLength(3);
  expect(frames.at(-1)!.snapshot!.revision).toBe(revision);
});
it("SPlayer 暂停、继续、拖动与切歌沿用官方控制码", async () => {
  const { client, frames, api } = setup();
  await client.start(invite);
  for (const command of [
    { type: "pause" },
    { type: "play" },
    { type: "seek", position: 35000 },
    { type: "next" },
  ] as const)
    await client.send({ type: "command", command });
  expect(api.control.mock.calls.map((c) => c[1])).toEqual([3, 2, 7, 4]);
  expect(frames.at(-1)!.snapshot).toMatchObject({ index: 1, position: 0 });
});
it("QQ 官方房间结束后不自动重建或影响其他房间", async () => {
  const { client, api, frames } = setup();
  await client.start(invite);
  api.heartbeat.mockRejectedValue(new Error("QM API 错误: outer=0 inner=11001"));
  await vi.advanceTimersByTimeAsync(2100);
  expect(frames.at(-1)!.connection).toBe("idle");
  const count = api.heartbeat.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30000);
  expect(api.heartbeat).toHaveBeenCalledTimes(count);
  expect(api.create).not.toHaveBeenCalled();
});
it("退出仅调用本机退出，停止测试不会擅自退掉官方房间", async () => {
  const { client, api } = setup();
  await client.start(invite);
  client.stop();
  expect(api.quit).not.toHaveBeenCalled();
  const other = setup();
  await other.client.start(invite);
  await other.client.leave();
  expect(other.api.quit).toHaveBeenCalledWith("LUGC123");
});

it("创建官方房间后显式暂停，并使用包含完整歌曲身份的分享链接", async () => {
  const { client, api, frames } = setup();
  await client.host(
    [
      { id: "MID11", extId: "11", source: "qqmusic", title: "一", artists: [], duration: 300000 },
      { id: "MID22", extId: "22", source: "qqmusic", title: "二", artists: [], duration: 300000 },
    ],
    0,
    10000,
  );
  expect(api.create.mock.calls[0][0]).toHaveLength(2);
  expect(api.control.mock.calls[0][1]).toBe(3);
  expect(frames.at(-1)).toMatchObject({ hosting: true, snapshot: { playing: false } });
  expect(frames.at(-1)!.invite).toContain("showid=LUGC123");
});
it("离线后绝不对另一方发出回退或暂停指令", async () => {
  const { client, api } = setup();
  await client.start(invite);
  client.stop();
  await client.send({ type: "command", command: { type: "pause" } });
  expect(api.control).not.toHaveBeenCalled();
});

it("先建空房并保持连接，不反复拉取空队列，也不发送播放控制", async () => {
  const { client, api, frames, empty } = setup();
  empty();
  await client.host();
  expect(api.create).toHaveBeenCalledWith([], 0, 0);
  expect(frames.at(-1)).toMatchObject({
    connection: "connected",
    hosting: true,
    snapshot: { tracks: [], index: -1, playing: false, counting: false, position: 0 },
  });
  expect(frames.at(-1)!.invite).not.toContain("songid");
  await vi.advanceTimersByTimeAsync(6100);
  expect(api.playlist).toHaveBeenCalledOnce();
  expect(api.control).not.toHaveBeenCalled();
});

it("空房间可以先加入歌曲保持暂停，随后播放完整歌单", async () => {
  const { client, api, frames, empty } = setup();
  empty();
  await client.host();
  const tracks = [11, 22].map((id) => ({
    source: "qqmusic" as const,
    id: `MID${id}`,
    extId: String(id),
    title: String(id),
    artists: [],
    duration: 300000,
  }));
  await client.send({
    type: "command",
    command: { type: "enqueue", tracks: [tracks[0]], position: "end" },
  });
  expect(api.control.mock.calls.map((c) => c[1])).toEqual([1, 3]);
  expect(frames.at(-1)!.snapshot).toMatchObject({ playing: false, index: 0 });
  await client.send({ type: "command", command: { type: "queue", tracks, index: 1 } });
  expect(frames.at(-1)!.snapshot).toMatchObject({ playing: true, index: 1 });
  expect(frames.at(-1)!.snapshot!.tracks).toHaveLength(2);
});

it("加入另一端创建的空房后可直接选一首歌播放", async () => {
  const { client, api, frames, empty } = setup();
  empty();
  await client.start(invite.replace("&songid=11", ""));
  await client.send({
    type: "command",
    command: {
      type: "playTrack",
      track: {
        source: "qqmusic",
        id: "MID11",
        extId: "11",
        title: "一",
        artists: [],
        duration: 300000,
      },
    },
  });
  expect(api.control.mock.calls.map((c) => c[1])).toEqual([1, 4]);
  expect(frames.at(-1)!.snapshot).toMatchObject({ playing: true, index: 0 });
});

it("重连自己创建的房间时恢复房主身份，不新建另一个房间", async () => {
  const { api } = setup();
  api.join.mockResolvedValue({ entryInfo: { roomInfo: { createUin: "123456" } } });
  const frames: TogetherStatus[] = [];
  const client = new QQMusicTogether(api, (frame) => frames.push(frame), ["123456"]);
  instances.push(client);
  await client.start(invite);
  expect(frames.at(-1)!.hosting).toBe(true);
  expect(api.create).not.toHaveBeenCalled();
});
