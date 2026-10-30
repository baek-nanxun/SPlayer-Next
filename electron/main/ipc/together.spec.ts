import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  cookies: { qm_keyst: "test-key" } as Record<string, string>,
  uin: "123456",
  request: vi.fn(),
  publish: vi.fn(),
  netease: vi.fn(),
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
vi.mock("@main/utils/logger", () => ({ coreLog: { warn: vi.fn() } }));
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
