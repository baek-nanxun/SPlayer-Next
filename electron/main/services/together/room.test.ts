import assert from "node:assert/strict";
import { test } from "node:test";
import WebSocket from "ws";
import { TogetherRoom, cleanTracks, startTogetherServer } from "./room";
import type { TogetherSnapshot } from "../../../../shared/types/together";
const tracks = [
  { id: "one", source: "qqmusic" as const, title: "歌曲一", artists: [], duration: 100000 },
  { id: "two", source: "netease" as const, title: "歌曲二", artists: [], duration: 100000 },
];
/** 提供可控制时钟的双人房间 */
const setup = () => {
  let now = 1000;
  const room = new TogetherRoom(() => now);
  room.join("a", "甲");
  room.join("b", "乙");
  room.command("a", { type: "queue", tracks, index: 0 });
  /** 确认当前版本的两位成员 */
  const ready = (): void => {
    room.ready("a", room.revision);
    room.ready("b", room.revision);
  };
  return {
    room,
    ready,
    advance: (ms: number) => {
      now += ms;
    },
  };
};
test("双方同权控制，最后接收的操作生效且进度不增加一起听时长", () => {
  const { room, ready, advance } = setup();
  ready();
  advance(3000);
  room.command("b", { type: "pause" });
  assert.equal(room.snapshot().elapsedMs, 3000);
  advance(10000);
  assert.equal(room.snapshot().elapsedMs, 3000);
  room.command("b", { type: "seek", position: 50000 });
  ready();
  assert.equal(room.snapshot().position, 50000);
  room.command("a", { type: "play" });
  ready();
  advance(2000);
  room.command("b", { type: "next" });
  assert.equal(room.index, 1);
  assert.equal(room.elapsedMs, 5000);
  room.command("a", { type: "prev" });
  assert.equal(room.index, 0);
  room.command("a", { type: "pause" });
  room.command("b", { type: "play" });
  ready();
  assert.equal(room.playing, true);
});
test("等待第二人、准备中、断线期间均不累计，重连保留时长", () => {
  const { room, ready, advance } = setup();
  advance(1000);
  assert.equal(room.snapshot().elapsedMs, 0);
  room.ready("a", room.revision);
  advance(2000);
  assert.equal(room.snapshot().elapsedMs, 0);
  ready();
  advance(5000);
  room.disconnect("b");
  assert.equal(room.elapsedMs, 5000);
  advance(20000);
  room.join("b", "乙");
  assert.equal(room.snapshot().elapsedMs, 5000);
  ready();
  advance(1000);
  assert.equal(room.snapshot().elapsedMs, 6000);
});
test("迟到准备确认不能启动已被暂停的版本", () => {
  const { room, ready } = setup();
  const old = room.revision;
  room.command("a", { type: "pause" });
  room.ready("a", old);
  room.ready("b", old);
  assert.equal(room.playing, false);
  assert.equal(room.members.get("b")?.ready, false);
  ready();
  assert.equal(room.playing, false);
});
test("曲末仅由服务切换一次，不把越过曲末的时间累计", () => {
  const { room, ready, advance } = setup();
  ready();
  advance(101000);
  assert.equal(room.tick(), true);
  assert.equal(room.index, 1);
  assert.equal(room.elapsedMs, 100000);
  assert.equal(room.tick(), false);
});
test("第三人拒绝加入，显式退出后释放席位", () => {
  const { room } = setup();
  assert.throws(() => room.join("c", "丙"), /已满/);
  room.leave("b");
  room.join("c", "丙");
  assert.equal(room.members.size, 2);
});
test("共享资料移除本地路径、音源 URL 和不受支持来源", () => {
  const result = cleanTracks([
    { ...tracks[0], path: "/private/file", url: "https://secret", coverOriginal: "https://secret" },
  ]);
  assert.equal("path" in result[0], false);
  assert.equal("url" in result[0], false);
  assert.throws(() => cleanTracks([{ ...tracks[0], source: "local" }]), /在线歌曲/);
  assert.throws(() => cleanTracks(Array.from({ length: 2001 }, () => tracks[0])), /200/);
});

test("真实 WebSocket 双人控制、聊天、断线重连与房间隔离", async () => {
  const server = await startTogetherServer(0, "127.0.0.1");
  const sockets: WebSocket[] = [];
  const ids = ["aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb"];
  /** 连接测试客户端并缓存收到的快照
   * @param id - 测试成员标识
   * @param secret - 房间密钥
   */
  const connect = async (id: string, secret = server.secret) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    sockets.push(ws);
    const states: TogetherSnapshot[] = [];
    const errors: string[] = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "state") states.push(msg.state);
      if (msg.type === "error") errors.push(msg.error);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "join", id, secret, name: id[0] }));
    return { ws, states, errors, send: (value: unknown) => ws.send(JSON.stringify(value)) };
  };
  /** 等待网络状态收敛
   * @param condition - 完成条件
   */
  const until = async (condition: () => boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (condition()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("房间未收敛");
  };
  try {
    const a = await connect(ids[0]),
      b = await connect(ids[1]);
    await until(() => a.states.at(-1)?.members.length === 2);
    b.send({ type: "command", command: { type: "queue", tracks, index: 0 } });
    await until(() => a.states.at(-1)?.tracks.length === 2);
    const revision = a.states.at(-1)!.revision;
    a.send({ type: "ready", revision });
    b.send({ type: "ready", revision });
    await until(() => a.states.at(-1)?.playing === true);
    a.send({ type: "command", command: { type: "seek", position: 40000 } });
    await until(() => {
      const latest = b.states.at(-1);
      return (
        !!latest &&
        latest.revision > revision &&
        latest.position >= 40000 &&
        latest.position < 41000
      );
    });
    b.send({ type: "command", command: { type: "pause" } });
    await until(() => a.states.at(-1)?.desiredPlaying === false);
    b.send({ type: "chat", text: "一起听" });
    await until(() => a.states.at(-1)?.chat[0]?.text === "一起听");
    assert.equal(a.states.at(-1)!.chat[0].senderId, ids[1]);
    a.send({ type: "chat", text: "第二条" });
    await until(() => b.states.at(-1)?.chat.length === 2);
    assert.equal(a.states.at(-1)!.chat.length, 2);
    assert.notEqual(b.states.at(-1)!.chat[0].id, b.states.at(-1)!.chat[1].id);
    const invalid = await connect("cccccccccccccccccccccccc", "wrong");
    await until(() => invalid.errors.length > 0);
    assert.equal(invalid.states.length, 0);
    b.ws.terminate();
    await until(() => a.states.at(-1)?.members.some((x) => !x.online) === true);
    const restored = await connect(ids[1]);
    await until(() => restored.states.at(-1)?.members.every((x) => x.online) === true);
    assert.equal(restored.states.at(-1)?.chat[0]?.text, "一起听");
  } finally {
    for (const s of sockets) s.terminate();
    server.close();
  }
});

test("双方同时加歌会合并到房间队列，不覆盖原列表或中断当前歌曲", () => {
  const { room, ready, advance } = setup();
  ready();
  advance(12000);
  const revision = room.revision;
  room.command("a", { type: "enqueue", tracks: [{ ...tracks[0], id: "three" }], position: "end" });
  room.command("b", { type: "enqueue", tracks: [{ ...tracks[0], id: "four" }], position: "next" });
  assert.deepEqual(
    room.tracks.map((t) => t.id),
    ["one", "four", "two", "three"],
  );
  assert.equal(room.revision, revision);
  assert.equal(room.playing, true);
  assert.equal(room.position, 12000);
  assert.equal(room.snapshot().queueRevision, 3);
});

test("立即播放插入或选择歌曲，完整共享歌单继续保留", () => {
  const { room, ready } = setup();
  ready();
  room.command("a", { type: "playTrack", track: { ...tracks[0], id: "new" } });
  assert.deepEqual(
    room.tracks.map((t) => t.id),
    ["one", "new", "two"],
  );
  assert.equal(room.index, 1);
  room.command("b", { type: "playTrack", track: tracks[1] });
  assert.equal(room.index, 2);
  assert.equal(room.tracks.length, 3);
  room.command("a", { type: "next" });
  assert.equal(room.index, 0);
});

test("单曲队列点击下一首提示加歌，不倒退到开头", () => {
  const { room, ready, advance } = setup();
  room.command("a", { type: "queue", tracks: [tracks[0]], index: 0 });
  ready();
  advance(10000);
  assert.throws(() => room.command("b", { type: "next" }), /只有一首/);
  assert.equal(room.position, 10000);
  assert.equal(room.playing, true);
});

test("移除和拖动非当前歌曲保持播放进度，清空同步停止", () => {
  const { room, ready, advance } = setup();
  ready();
  advance(5000);
  const revision = room.revision;
  room.command("b", { type: "move", track: tracks[0], before: null });
  assert.equal(room.index, 1);
  assert.equal(room.position, 5000);
  assert.equal(room.revision, revision);
  room.command("a", { type: "remove", track: tracks[1] });
  assert.equal(room.index, 0);
  assert.equal(room.position, 5000);
  assert.equal(room.playing, true);
  room.command("a", { type: "clear" });
  assert.equal(room.tracks.length, 0);
  assert.equal(room.desiredPlaying, false);
  assert.equal(room.playing, false);
});

test("同平台重复加歌去重，跨平台同 ID 不错误合并", () => {
  const { room } = setup();
  room.command("b", {
    type: "enqueue",
    tracks: [tracks[0], { ...tracks[0], source: "netease" }],
    position: "end",
  });
  assert.equal(room.tracks.length, 3);
  assert.equal(room.tracks[2].source, "netease");
});

test("274 首喜欢歌曲和 1113 首完整歌单可以直接同步", () => {
  const { room } = setup();
  const playlist = Array.from({ length: 1113 }, (_, i) => ({ ...tracks[0], id: String(i + 1) }));
  room.command("a", { type: "queue", tracks: playlist, index: 273 });
  assert.equal(room.tracks.length, 1113);
  assert.equal(room.index, 273);
  assert.throws(
    () =>
      room.command("b", {
        type: "queue",
        tracks: Array.from({ length: 2001 }, () => tracks[0]),
        index: 0,
      }),
    /2000/,
  );
});

test("成员头像保留，拒绝脚本或本地文件地址", () => {
  const room = new TogetherRoom();
  room.join("a", "甲", "https://example.com/avatar.jpg");
  room.join("b", "乙", "file:///etc/passwd");
  assert.equal(room.snapshot().members[0].avatar, "https://example.com/avatar.jpg");
  assert.equal(room.snapshot().members[1].avatar, undefined);
});

test("慢的一方缓冲不暂停听友，累计时长仅在双方准备时增长", () => {
  const { room, ready, advance } = setup();
  ready();
  advance(2000);
  room.unavailable("b");
  const revision = room.revision;
  assert.equal(room.playing, true);
  assert.equal(room.counting(), false);
  advance(8000);
  const snapshot = room.snapshot();
  assert.equal(snapshot.position, 10000);
  assert.equal(snapshot.elapsedMs, 2000);
  assert.equal(snapshot.revision, revision);
  room.ready("b", revision);
  advance(1000);
  assert.equal(room.snapshot().elapsedMs, 3000);
});

test("一人断线重连时保留连续播放的时钟，不拉另一人回退", () => {
  const { room, ready, advance } = setup();
  ready();
  advance(2000);
  room.disconnect("b");
  const revision = room.revision;
  advance(10000);
  room.join("b", "乙");
  assert.equal(room.revision, revision);
  assert.equal(room.position, 12000);
  assert.equal(room.playing, true);
  assert.equal(room.elapsedMs, 2000);
});

test("封面和专辑穿过共享校验，拒绝本地、脚本和带凭据的图片地址", () => {
  const result = cleanTracks([
    {
      ...tracks[0],
      cover: "https://y.gtimg.cn/cover.jpg",
      album: {
        id: "album",
        name: "专辑",
        cover: "https://y.gtimg.cn/album.jpg",
        privatePath: "/private",
      },
      fee: 1,
    },
  ])[0];
  assert.equal(result.cover, "https://y.gtimg.cn/cover.jpg");
  assert.deepEqual(result.album, {
    id: "album",
    name: "专辑",
    cover: "https://y.gtimg.cn/album.jpg",
  });
  for (const cover of [
    "file:///private",
    "cover://local",
    "javascript:alert(1)",
    "https://user:secret@example.com/cover.jpg",
  ])
    assert.equal(cleanTracks([{ ...tracks[0], cover }])[0].cover, undefined);
});

test("房间洗牌保持当前进度，双方共用随机顺序，自然下一曲不重置模式", () => {
  let now = 0;
  const room = new TogetherRoom(
    () => now,
    () => 0,
  );
  room.join("a", "甲");
  room.join("b", "乙");
  const list = ["a", "b", "c", "d"].map((id) => ({ ...tracks[0], id }));
  room.command("a", { type: "queue", tracks: list, index: 0 });
  now = 12000;
  const revision = room.revision;
  room.command("b", { type: "mode", shuffleMode: "on" });
  assert.equal(room.revision, revision);
  assert.equal(room.position, 12000);
  assert.deepEqual(
    room.tracks.map((t) => t.id),
    ["a", "c", "d", "b"],
  );
  assert.equal(room.snapshot().shuffleMode, "on");
  now = 100000;
  assert.equal(room.tick(), true);
  assert.equal(room.tracks[room.index].id, "c");
  assert.equal(room.snapshot().shuffleMode, "on");
  room.command("a", { type: "mode", shuffleMode: "off" });
  assert.deepEqual(
    room.tracks.map((t) => t.id),
    ["a", "b", "c", "d"],
  );
  assert.equal(room.index, 2);
  assert.equal(room.position, 0);
});

test("随机模式保留新增与删除，关闭随机恢复原顺序且不复活删除曲目", () => {
  const { room } = setup();
  room.command("a", { type: "mode", shuffleMode: "on" });
  room.command("b", { type: "enqueue", position: "end", tracks: [{ ...tracks[0], id: "three" }] });
  room.command("b", { type: "remove", track: tracks[1] });
  room.command("a", { type: "mode", shuffleMode: "off" });
  assert.deepEqual(
    room.tracks.map((t) => t.id),
    ["one", "three"],
  );
  room.command("b", { type: "mode", shuffleMode: "on" });
  room.command("a", {
    type: "queue",
    tracks: [tracks[0], tracks[1], { ...tracks[0], id: "four" }],
    index: 1,
  });
  assert.equal(room.snapshot().shuffleMode, "on");
  assert.equal(room.tracks[room.index].id, "two");
});

test("单曲循环由房间在自然结束时重播，手动切歌仍可前进", () => {
  const { room, advance } = setup();
  room.command("a", { type: "mode", repeatMode: "one" });
  advance(100000);
  assert.equal(room.tick(), true);
  assert.equal(room.index, 0);
  assert.equal(room.position, 0);
  room.command("b", { type: "next" });
  assert.equal(room.index, 1);
  assert.equal(room.snapshot().repeatMode, "one");
});
