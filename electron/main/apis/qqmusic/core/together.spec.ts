import { beforeEach, expect, it, vi } from "vitest";
import { createQQTogetherApi, parseQQTogetherInvite, type QQTogetherRequest } from "./together";
const request = vi.fn<QQTogetherRequest>();
const session = { uin: "123456", musicKey: "test-key" };
const api = createQQTogetherApi(
  <T>(...args: Parameters<QQTogetherRequest>) => request(...args) as Promise<T>,
  () => session,
);
const queue = [
  { songID: 11, songType: 0, songIndex: 0, title: "一" },
  { songID: 22, songType: 0, songIndex: 1, title: "二" },
];
beforeEach(() => {
  request.mockReset().mockResolvedValue({});
  session.uin = "123456";
  session.musicKey = "test-key";
});
it("解析官方 QQ 音乐邀请，保留音乐房间和加密邀请者信息", () => {
  const parsed = parseQQTogetherInvite(
    "一起听 https://i.y.qq.com/n2/m/share/listen_together/index.html?showid=LUGC123&songid=22&share_encrypt_uin=abc (@QQ音乐)",
  );
  expect(parsed).toMatchObject({ showID: "LUGC123", fromEncryptedUin: "abc", songId: 22 });
});
it("拒绝其他域名、非音乐分享页和错误房间标识", () => {
  for (const url of [
    "https://example.com/n2/m/share/listen_together/index.html?showid=LUGC1",
    "https://i.y.qq.com.evil.test/n2/m/share/listen_together/index.html?showid=LUGC1",
    "http://i.y.qq.com/n2/m/share/listen_together/index.html?showid=LUGC1",
    "https://i.y.qq.com/n2/m/share/details/taoge.html?showid=LUGC1",
    "https://i.y.qq.com/n2/m/share/listen_together/index.html?showid=123",
  ])
    expect(() => parseQQTogetherInvite(url)).toThrow();
});
it("加入走 QQ 音乐 LightUGC 服务，禁用重试与凭据刷新", async () => {
  await api.join("LUGC123", "encrypted");
  expect(request).toHaveBeenCalledWith(
    "music.lightUGCRoom.LightUGCRoomSvr",
    "LightUGCRoomEntry",
    {
      showID: "LUGC123",
      fromEncryptedUin: "encrypted",
      entryType: 0,
      fromTag: 0,
      avatarValid: 0,
      musicWorldValid: 0,
      songInfos: [],
    },
    { retry: false, session: false, autoRefresh: false, appGateway: true },
  );
});
it("创建时包含完整 274 首队列，并默认保持暂停", async () => {
  request.mockResolvedValue({ entryInfo: { roomInfo: { showID: "LUGC123" } } });
  const list = Array.from({ length: 274 }, (_, i) => ({
    songID: i + 1,
    songType: 0,
    songIndex: i,
    title: `歌曲${i}`,
  }));
  await api.create(list, 17, 12345);
  expect(request.mock.calls[0][2]).toMatchObject({
    playStatus: 2,
    seekTime: 12345,
    songOffset: 12345,
    songPlaying: list[17],
    songInfos: list,
  });
});
it("创建没有返回房间 ID 时不能宣布成功", async () => {
  await expect(api.create(queue, 0, 0)).rejects.toThrow("房间号无效");
});
it("心跳不携带播放或暂停指令", async () => {
  request.mockResolvedValue({ songInfo: { playStatus: 1, songOffset: 5000 }, users: [] });
  await api.heartbeat("LUGC123");
  expect(request.mock.calls[0][2]).toEqual({ showID: "LUGC123" });
  expect(request.mock.calls[0][1]).toBe("LightUGCRoomHeartBeat");
});
it("队列读取失败不能把空列表或单曲作为完整列表返回", async () => {
  await expect(api.playlist("LUGC123")).rejects.toThrow("1–1000");
  request.mockResolvedValue({ songList: queue });
  await expect(api.playlist("LUGC123")).resolves.toEqual(queue);
  expect(request.mock.calls.at(-1)![2]).toEqual({ showID: "LUGC123", cmd: 0 });
});
it("播放暂停拖动均保留毫秒位置，切歌明确从零开始", async () => {
  for (const cmd of [2, 3, 7]) {
    await api.control("LUGC123", cmd, queue, 1, 12345);
    expect(request.mock.calls.at(-1)![2]).toMatchObject({
      cmd,
      songPlaying: queue[1],
      seekTime: 12345,
      songOffset: 12345,
    });
  }
  await api.control("LUGC123", 4, queue, 0, 12345);
  expect(request.mock.calls.at(-1)![2]).toMatchObject({
    cmd: 4,
    songOffset: 0,
    songPlaying: queue[0],
  });
});
it("整表同步传入全队列，不把 MID 当作数字歌曲 ID", async () => {
  await api.control("LUGC123", 1, queue, 0, 12000);
  expect(request.mock.calls[0][2]).toMatchObject({
    cmd: 1,
    songList: queue,
    songPlaying: queue[0],
  });
  expect(() => api.control("LUGC123", 1, [{ ...queue[0], songID: "qqMID" }], 0, 0)).toThrow(
    "歌曲 ID",
  );
});
it("未登录、未知指令、无效进度和越界索引均不发网络请求", async () => {
  for (const p of [undefined, null, "", NaN, Infinity, -1, 0.5, {}, true])
    expect(() => api.control("LUGC123", 7, queue, 0, p)).toThrow("进度无效");
  expect(() => api.control("LUGC123", 6, queue, 0, 0)).toThrow("未验证");
  expect(() => api.control("LUGC123", 2, queue, 2, 0)).toThrow("超出队列");
  expect(request).not.toHaveBeenCalled();
  session.musicKey = "";
  await expect(api.join("LUGC123")).rejects.toThrow("请先登录");
  expect(request).not.toHaveBeenCalled();
});
it("只退出本机音乐账号，不把其他成员放入退出列表", async () => {
  await api.quit("LUGC123");
  expect(request.mock.calls[0][2]).toEqual({
    showID: "LUGC123",
    uinList: ["123456"],
    from: "player",
  });
});
it("接口请求期间账号变化后不消费旧房间响应", async () => {
  request.mockImplementationOnce(async () => {
    session.uin = "654321";
    return {} as never;
  });
  await expect(api.join("LUGC123")).rejects.toThrow("账号已变更");
});

it("元数据批量读取保留原始歌曲类型，缺失列表不能伪装成功", async () => {
  request.mockResolvedValueOnce({
    tracks: [{ id: 11, type: 1, mid: "MID11", title: "一", interval: 300 }],
  });
  await expect(api.tracks([11])).resolves.toMatchObject([{ id: 11, type: 1, mid: "MID11" }]);
  expect(request.mock.calls[0][2]).toEqual({ ids: [11], types: [0] });
  await expect(api.tracks([11])).rejects.toThrow("未返回歌曲详情");
});
it("MID 仅通过官方歌曲详情解析，不强转为数字", async () => {
  request.mockResolvedValueOnce({
    track_info: { id: 11, type: 1, mid: "MID11", title: "一", interval: 300 },
  });
  await expect(api.resolve("MID11")).resolves.toMatchObject({ id: 11, type: 1 });
  expect(request.mock.calls[0][2]).toEqual({ song_type: 0, song_mid: "MID11" });
});
