import { beforeEach, expect, it, vi } from "vitest";
import { listenTogetherModules } from "./listentogether";
import type { RequestFn } from "../core/types";

const request = vi.fn<RequestFn>();
const session = { cookie: { MUSIC_U: "test-session" } };
beforeEach(() => {
  request.mockReset().mockResolvedValue({ status: 200, body: { code: 200 }, cookie: [] });
});
it("九个官方接口均已注册且查询状态使用 weapi", async () => {
  expect(Object.keys(listenTogetherModules)).toHaveLength(9);
  await listenTogetherModules.listentogether_status(session, request);
  expect(request).toHaveBeenCalledWith(
    "/api/listen/together/status/get",
    {},
    expect.objectContaining({ crypto: "weapi", retry: false }),
  );
});
it("创建房间沿用当前网易云会话且不启用网页重试", async () => {
  await listenTogetherModules.listentogether_room_create({ ...session, client: "web" }, request);
  expect(request).toHaveBeenCalledWith(
    "/api/listen/together/room/create",
    { refer: "songplay_more" },
    expect.objectContaining({
      cookie: session.cookie,
      crypto: "eapi",
      retry: false,
      client: undefined,
    }),
  );
});
it("未登录网易云时不发请求，不使用 QQ 凭据代替", async () => {
  await expect(
    listenTogetherModules.listentogether_status({ cookie: { uin: "10001" } }, request),
  ).rejects.toThrow("请先登录网易云");
  expect(request).not.toHaveBeenCalled();
});
it("官方邀请的房间和邀请者字段完整传入", async () => {
  await listenTogetherModules.listentogether_accept(
    { ...session, roomId: "room_123-abc", inviterId: "1234" },
    request,
  );
  expect(request.mock.calls[0][1]).toEqual({
    roomId: "room_123-abc",
    inviterId: "1234",
    refer: "inbox_invite",
  });
  expect(() =>
    listenTogetherModules.listentogether_accept({ ...session, roomId: "" }, request),
  ).toThrow("roomId 无效");
});
it("控制指令保留毫秒进度、目标歌曲和单调序列号", async () => {
  await listenTogetherModules.listentogether_play_command(
    {
      ...session,
      roomId: "room",
      commandType: "seek",
      playStatus: "PLAY",
      progress: 12345,
      formerSongId: "-1",
      targetSongId: "347230",
      clientSeq: 7,
    },
    request,
  );
  expect(JSON.parse(String(request.mock.calls[0][1].commandInfo))).toEqual({
    commandType: "SEEK",
    progress: 12345,
    playStatus: "PLAY",
    formerSongId: "-1",
    targetSongId: "347230",
    clientSeq: 7,
  });
});
it("拒绝非法进度与非网易云歌曲，不将空进度默认为零", () => {
  const q = {
    ...session,
    roomId: "room",
    commandType: "PLAY",
    playStatus: "PLAY",
    formerSongId: "-1",
    targetSongId: "347230",
    clientSeq: 1,
  };
  for (const progress of [undefined, null, "", -1, NaN, Infinity, 0.1])
    expect(() =>
      listenTogetherModules.listentogether_play_command({ ...q, progress }, request),
    ).toThrow("progress 无效");
  expect(() =>
    listenTogetherModules.listentogether_play_command(
      { ...q, progress: 0, targetSongId: "qqMID" },
      request,
    ),
  ).toThrow("网易云歌曲 ID");
  expect(request).not.toHaveBeenCalled();
});
it("整表替换保留 274 首完整顺序和版本", async () => {
  const ids = Array.from({ length: 274 }, (_, i) => String(i + 1));
  await listenTogetherModules.listentogether_sync_list_command(
    {
      ...session,
      roomId: "room",
      commandType: "REPLACE",
      userId: "1234",
      version: 2,
      displayList: ids,
    },
    request,
  );
  const param = JSON.parse(String(request.mock.calls[0][1].playlistParam));
  expect(param.displayList).toEqual(ids);
  expect(param.randomList).toEqual(ids);
  expect(param.version).toEqual([{ userId: "1234", version: 2 }]);
});
it("不发送混合平台、不一致的随机列表或未经验证的指令", () => {
  const q = { ...session, roomId: "room", userId: "1234", version: 2, commandType: "REPLACE" };
  for (const displayList of [[], ["qqMID"], ["0"], Array(2001).fill("1")])
    expect(() =>
      listenTogetherModules.listentogether_sync_list_command({ ...q, displayList }, request),
    ).toThrow();
  expect(() =>
    listenTogetherModules.listentogether_sync_list_command(
      { ...q, displayList: "1,2", randomList: "1,3" },
      request,
    ),
  ).toThrow("不一致");
  expect(request).not.toHaveBeenCalled();
});
it("HTTP 200 但业务拒绝时不能宣布同步成功", async () => {
  request.mockResolvedValueOnce({
    status: 200,
    body: { code: 200, data: { result: false, message: "房间已过期" } },
    cookie: [],
  });
  await expect(
    listenTogetherModules.listentogether_room_check({ ...session, roomId: "room" }, request),
  ).rejects.toThrow("房间已过期");
});
it("结束房间失败必须保留未退出的状态", async () => {
  request.mockResolvedValueOnce({
    status: 200,
    body: { code: 200, data: { success: false } },
    cookie: [],
  });
  await expect(
    listenTogetherModules.listentogether_end({ ...session, roomId: "room" }, request),
  ).rejects.toThrow("未成功");
});
