import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startTogetherServer } from "./room";

const servers: Awaited<ReturnType<typeof startTogetherServer>>[] = [];
const clients: WebSocket[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] }));
afterEach(() => {
  for (const ws of clients.splice(0)) ws.terminate();
  for (const server of servers.splice(0)) server.close();
  vi.useRealTimers();
});
/** 等待实际 TCP 消息到达，不把网络事件替换成模拟快照
 * @param ready - 验证条件
 */
const until = async (ready: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (ready()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw Error("WebSocket 状态未到达");
};
/** 创建可观测的真实客户端
 * @param server - 房间服务
 * @param id - 恢复身份
 * @param compact - 是否支持精简快照
 */
const join = async (server: (typeof servers)[number], id: string, compact = true) => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { autoPong: false });
  clients.push(ws);
  const frames: Array<{ type: string; state?: Record<string, unknown>; error?: string }> = [];
  ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
  await new Promise<void>((done, reject) => {
    ws.once("open", done);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "join", id, name: "听友", secret: server.secret, compact }));
  await until(() => frames.some((x) => x.type === "state"));
  return { ws, frames };
};
it("一次心跳迟到不踢人，恢复后继续连接，真正失联才清理", async () => {
  const server = await startTogetherServer(0, "127.0.0.1");
  servers.push(server);
  const { ws } = await join(server, "aaaaaaaaaaaaaaaaaaaaaaaa");
  await vi.advanceTimersByTimeAsync(15000);
  expect(ws.readyState).toBe(WebSocket.OPEN);
  ws.pong();
  await new Promise((done) => setTimeout(done, 20));
  await vi.advanceTimersByTimeAsync(14000);
  expect(ws.readyState).toBe(WebSocket.OPEN);
  await vi.advanceTimersByTimeAsync(31000);
  await until(() => ws.readyState === WebSocket.CLOSED);
});
it("精简心跳不重复发送274首歌，旧客户端仍收到完整快照，加歌与聊天可更新", async () => {
  const server = await startTogetherServer(0, "127.0.0.1");
  servers.push(server);
  const modern = await join(server, "aaaaaaaaaaaaaaaaaaaaaaaa");
  const legacy = await join(server, "bbbbbbbbbbbbbbbbbbbbbbbb", false);
  const tracks = Array.from({ length: 274 }, (_, i) => ({
    id: `MID${i}`,
    source: "qqmusic" as const,
    title: `歌曲${i}`,
    duration: 300000,
    artists: [],
    cover: "https://y.gtimg.cn/test.jpg",
  }));
  server.room.command("aaaaaaaaaaaaaaaaaaaaaaaa", { type: "queue", tracks, index: 0 });
  await vi.advanceTimersByTimeAsync(5000);
  await until(() => (modern.frames.at(-1)?.state?.tracks as unknown[])?.length === 274);
  const fullSize = JSON.stringify(modern.frames.at(-1)).length;
  modern.frames.length = 0;
  legacy.frames.length = 0;
  await vi.advanceTimersByTimeAsync(5000);
  await until(() => modern.frames.length > 0 && legacy.frames.length > 0);
  expect(modern.frames.at(-1)!.state!.tracks).toBeUndefined();
  expect(JSON.stringify(modern.frames.at(-1)).length).toBeLessThan(fullSize / 10);
  expect(legacy.frames.at(-1)!.state!.tracks).toHaveLength(274);
  modern.ws.send(JSON.stringify({ type: "chat", text: "你好" }));
  await until(() => (modern.frames.at(-1)?.state?.chat as unknown[])?.length === 1);
  server.room.command("aaaaaaaaaaaaaaaaaaaaaaaa", {
    type: "enqueue",
    position: "end",
    tracks: [{ ...tracks[0], id: "new" }],
  });
  await vi.advanceTimersByTimeAsync(5000);
  await until(() => (modern.frames.at(-1)?.state?.tracks as unknown[])?.length === 275);
});
it("同一身份换连接时替换旧传输，旧连接关闭不把新连接标成离线", async () => {
  const server = await startTogetherServer(0, "127.0.0.1");
  servers.push(server);
  const old = await join(server, "aaaaaaaaaaaaaaaaaaaaaaaa");
  await join(server, "bbbbbbbbbbbbbbbbbbbbbbbb");
  const restored = await join(server, "aaaaaaaaaaaaaaaaaaaaaaaa");
  await until(() => old.ws.readyState === WebSocket.CLOSED);
  expect(restored.ws.readyState).toBe(WebSocket.OPEN);
  expect(server.room.snapshot().members.filter((m) => m.online)).toHaveLength(2);
  expect(restored.frames.some((x) => x.type === "error")).toBe(false);
});
