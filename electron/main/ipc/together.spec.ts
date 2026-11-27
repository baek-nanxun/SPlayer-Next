import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  cookies: { qm_keyst: "test-key" } as Record<string, string>,
  uin: "123456",
  request: vi.fn(),
  publish: vi.fn(),
  netease: vi.fn(),
  servers: [] as Array<{ close: () => void }>,
}));
vi.mock("electron", () => ({
  app: { once: vi.fn() },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler),
  },
}));
vi.mock("@main/apis/qqmusic/core/request", () => ({
  getQQMusicCookies: () => mocks.cookies,
  getQQMusicUin: () => mocks.uin,
  qmRequest: mocks.request,
}));
vi.mock("@main/apis/netease", () => ({
  callNetease: mocks.netease,
  getNeteaseCookies: () => ({ MUSIC_U: "test-cookie" }),
}));
vi.mock("@main/apis/netease/core/direct", () => ({ fetchNeteaseDirect: vi.fn() }));
vi.mock("@main/utils/broadcast", () => ({ sendToMain: mocks.publish }));
vi.mock("@main/utils/logger", () => ({ coreLog: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("@main/services/together/room", async (original) => {
  const actual = await original<typeof import("@main/services/together/room")>();
  return {
    ...actual,
    startTogetherServer: async () => {
      const server = await actual.startTogetherServer();
      mocks.servers.push(server);
      return server;
    },
  };
});
import { registerTogetherIpc } from "./together";

/** 调用真实 IPC 处理器并保留异步结果
 * @param name - 一起听通道
 * @param args - 通道参数
 */
const invoke = (name: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(mocks.handlers.get(`together:${name}`)!(null, ...args));

beforeEach(() => {
  mocks.handlers.clear();
  mocks.cookies = { qm_keyst: "test-key" };
  mocks.uin = "123456";
  mocks.request.mockReset().mockImplementation(async (_module, method) => {
    if (method === "LightUGCRoomCreate") return { entryInfo: { roomInfo: { showID: "LUGC123" } } };
    if (method === "LightUGCRoomHeartBeat") return { songInfo: { playStatus: 0 }, users: [] };
    if (method === "LightUGCRoomSongOper") return { songList: [] };
    return {};
  });
  registerTogetherIpc();
});
afterEach(async () => {
  await invoke("leave").catch(() => {});
  mocks.servers.splice(0).forEach((server) => server.close());
  vi.unstubAllGlobals();
});

it("晚到的短链解析不能挤掉后来已经连接的官方房间", async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  const joining = invoke("join", "https://c6.y.qq.com/base/fcgi-bin/u?__=old", "听友");
  const rejected = expect(joining).rejects.toThrow("取消");
  const latest = "https://i.y.qq.com/n2/m/share/listen_together/index.html?showid=LUGC222";
  await invoke("join", latest, "听友");
  resolve(
    new Response(null, {
      status: 302,
      headers: {
        location: "https://i.y.qq.com/n2/m/share/listen_together/index.html?showid=LUGC111",
      },
    }),
  );
  await rejected;
  expect(await invoke("status")).toMatchObject({ connection: "connected", invite: latest });
  expect(mocks.request.mock.calls.filter((args) => args[1] === "LightUGCRoomEntry")).toHaveLength(
    1,
  );
});

it("重复创建自建房只启动一个服务，不留下失控的房间连接", async () => {
  const creating = invoke("host", "听友", "127.0.0.1");
  const duplicate = expect(invoke("host", "听友", "127.0.0.1")).rejects.toThrow("退出");
  await creating;
  await duplicate;
  expect(mocks.servers).toHaveLength(1);
});

it("自建服务启动期间取消后，晚到服务被关闭且本机保持退出", async () => {
  const creating = invoke("host", "听友", "127.0.0.1");
  const cancelled = expect(creating).rejects.toThrow("取消");
  await invoke("leave");
  await cancelled;
  expect(await invoke("status")).toMatchObject({ connection: "idle", snapshot: null });
});

it("QQ 建房待返回时退出，会等待取得房号并退掉它，再允许重新建房", async () => {
  let resolve!: (value: unknown) => void;
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const creating = invoke("hostQQMusic", [], 0, 0);
  await Promise.resolve();
  const exiting = invoke("leave");
  expect(await invoke("status")).toMatchObject({ connection: "idle" });
  await expect(invoke("hostQQMusic", [], 0, 0)).rejects.toThrow("退房正在确认");
  resolve({ entryInfo: { roomInfo: { showID: "LUGCcancelled" } } });
  await creating;
  await exiting;
  expect(
    mocks.request.mock.calls
      .filter((args) => args[1] === "LightUGCRoomQuit")
      .map((args) => args[2].showID),
  ).toEqual(["LUGCcancelled"]);
  expect(mocks.request.mock.calls.some((args) => args[1] === "LightUGCRoomHeartBeat")).toBe(false);
  await invoke("hostQQMusic", [], 0, 0);
  expect(await invoke("status")).toMatchObject({ connection: "connected" });
});

it("取源刷新同账号密钥后，真实房间 IPC 仍可查询和退出", async () => {
  await invoke("hostQQMusic", [], 0, 0);
  mocks.cookies = { qm_keyst: "refreshed-key" };
  await expect(invoke("send", { type: "command", command: { type: "pause" } })).rejects.toThrow(
    "索引",
  );
  await expect(invoke("leave")).resolves.toBeUndefined();
  expect(mocks.request.mock.calls.some((args) => args[1] === "LightUGCRoomQuit")).toBe(true);
  expect(await invoke("status")).toMatchObject({ connection: "idle", snapshot: null });
});

it("真正切换账号后不使用新账号操作旧房间，但本机始终能够退出", async () => {
  await invoke("hostQQMusic", [], 0, 0);
  mocks.uin = "654321";
  await expect(invoke("leave")).rejects.toThrow("已退出本机");
  expect(await invoke("status")).toMatchObject({ connection: "idle", snapshot: null });
  expect(mocks.request.mock.calls.some((args) => args[1] === "LightUGCRoomQuit")).toBe(false);
});

it("官方退出失败也清理本机状态，晚到响应不能恢复房间", async () => {
  await invoke("hostQQMusic", [], 0, 0);
  mocks.request.mockRejectedValue(new Error("网络断开"));
  await expect(invoke("leave")).rejects.toThrow("官方退房未确认");
  expect(await invoke("status")).toMatchObject({ connection: "idle", invite: "", snapshot: null });
});

it("清理 QQ 退出流程时不回归网易云官方结束请求", async () => {
  let inRoom = false;
  const roomInfo = { roomId: "test-room", creatorId: 1, roomUsers: [] };
  mocks.netease.mockReset().mockImplementation(async (name) => {
    if (name === "listentogether_status")
      return { body: { code: 200, data: { inRoom, roomInfo } } };
    if (name === "listentogether_room_create") {
      inRoom = true;
      return { body: { code: 200, data: { roomInfo } } };
    }
    if (name === "listentogether_sync_playlist_get")
      return { body: { code: 200, data: { playlist: { displayList: { result: [] } } } } };
    if (name === "listentogether_end") return { body: { code: 200, data: { success: true } } };
    throw new Error("未知网易云接口");
  });
  await invoke("hostNetease");
  expect(await invoke("status")).toMatchObject({ connection: "connected", mode: "netease" });
  await invoke("leave");
  expect(mocks.netease).toHaveBeenCalledWith("listentogether_end", { roomId: "test-room" });
  expect(await invoke("status")).toMatchObject({ connection: "idle" });
});

it("自建精简快照沿用已验证列表，未变化心跳不丢歌或报响应无效", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  try {
    await invoke("host", "听友", "127.0.0.1");
    for (let i = 0; i < 100; i++) {
      if (((await invoke("status")) as { connection: string }).connection === "connected") break;
      await new Promise((done) => setTimeout(done, 5));
    }
    await invoke("send", {
      type: "command",
      command: {
        type: "queue",
        index: 0,
        tracks: [{ source: "qqmusic", id: "MID11", title: "一", artists: [], duration: 300000 }],
      },
    });
    for (let i = 0; i < 100; i++) {
      if (
        ((await invoke("status")) as { snapshot?: { tracks: unknown[] } }).snapshot?.tracks.length
      )
        break;
      await new Promise((done) => setTimeout(done, 5));
    }
    await vi.advanceTimersByTimeAsync(5000);
    await new Promise((done) => setTimeout(done, 20));
    expect(await invoke("status")).toMatchObject({
      connection: "connected",
      error: "",
      snapshot: { tracks: [{ id: "MID11" }] },
    });
  } finally {
    vi.useRealTimers();
  }
});
it("播放诊断只写本机日志，不把带凭据的错误发给听友", async () => {
  const { coreLog } = await import("@main/utils/logger");
  await invoke("send", {
    type: "diagnostic",
    event: "playback-error",
    error: "加载 https://example.com/song?vkey=secret-value 超时",
  });
  const text = JSON.stringify(vi.mocked(coreLog.info).mock.calls);
  expect(text).toContain("playback-error");
  expect(text).not.toContain("secret-value");
});

it("自建房建房时支持预置当前播放歌单与进度，首帧快照即保持播放态", async () => {
  await invoke("host", "听友", "127.0.0.1", "https://example.com/avatar.jpg", {
    tracks: [
      { source: "netease", id: "1982796627", title: "在听的歌", artists: [], duration: 240000 },
      { source: "qqmusic", id: "MID22", title: "下一首", artists: [], duration: 210000 },
    ],
    index: 0,
    position: 35000,
    playing: true,
    shuffleMode: "on",
    repeatMode: "one",
  });
  for (let i = 0; i < 100; i++) {
    if (((await invoke("status")) as { connection: string }).connection === "connected") break;
    await new Promise((done) => setTimeout(done, 5));
  }
  const status = (await invoke("status")) as {
    connection: string;
    hosting: boolean;
    snapshot: {
      playing: boolean;
      desiredPlaying: boolean;
      index: number;
      position: number;
      shuffleMode: string;
      repeatMode: string;
      tracks: Array<{ id: string }>;
    };
  };
  expect(status.connection).toBe("connected");
  expect(status.hosting).toBe(true);
  expect(status.snapshot.playing).toBe(true);
  expect(status.snapshot.desiredPlaying).toBe(true);
  expect(status.snapshot.index).toBe(0);
  expect(status.snapshot.position).toBeGreaterThanOrEqual(35000);
  expect(status.snapshot.shuffleMode).toBe("on");
  expect(status.snapshot.repeatMode).toBe("one");
  expect(status.snapshot.tracks.map((t) => t.id)).toEqual(["1982796627", "MID22"]);
});
