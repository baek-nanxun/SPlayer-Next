import assert from "node:assert/strict";
import { test } from "node:test";
import { createQQLibrary } from "./library";

type Call = { module: string; method: string; param: Record<string, unknown>; options?: unknown };
const setup = (respond: (call: Call) => unknown | Promise<unknown>) => {
  const calls: Call[] = [];
  const session = { uin: "10001", euin: "encrypted" };
  const api = createQQLibrary(
    async <T>(
      module: string,
      method: string,
      param: Record<string, unknown>,
      options?: unknown,
    ) => {
      const call = { module, method, param, options };
      calls.push(call);
      return (await respond(call)) as T;
    },
    () => session,
  );
  return { api, calls, session };
};
const ownPlaylist = { tid: 987654, dirId: 1001, dirName: "自建歌单" };

test("喜欢写入目录 201，先解析 MID 为数字 ID 和歌曲类型，禁用重试", async () => {
  const { api, calls } = setup(({ method }) =>
    method === "get_song_detail_yqq"
      ? { track_info: { id: 123, mid: "songMID", type: 1 } }
      : { retCode: 0 },
  );
  await api.tracks(undefined, ["songMID"], true, true);
  assert.equal(calls[1].method, "AddSonglist");
  assert.deepEqual(calls[1].param, {
    dirId: 201,
    tid: 0,
    bFmtUtf8: true,
    v_songInfo: [{ songId: 123, songType: 1 }],
  });
  assert.deepEqual(calls[1].options, { retry: false });
});

test("加入自建歌单不能把公开 ID 当作目录 ID", async () => {
  const { api, calls } = setup(({ method }) => {
    if (method === "GetPlaylistByUin") return { v_playlist: [ownPlaylist], bFinish: true };
    if (method === "get_song_detail_yqq")
      return { track_info: { id: 123, mid: "songMID", type: 0 } };
    return { retCode: 0 };
  });
  await api.tracks("987654", ["songMID"], false);
  assert.equal(calls[2].method, "DelSonglist");
  assert.equal(calls[2].param.dirId, 1001);
  assert.equal(calls[2].param.tid, 987654);
});

test("拒绝修改非本人歌单，不发出写请求", async () => {
  const { api, calls } = setup(() => ({ v_playlist: [ownPlaylist] }));
  await assert.rejects(api.delete("111"), /只能修改/);
  assert.equal(calls.length, 1);
});

test("喜欢默认歌单禁止删除", async () => {
  const { api, calls } = setup(() => ({ v_playlist: [{ tid: 222, dirId: 201 }] }));
  await assert.rejects(api.delete("222"), /不能删除/);
  assert.equal(calls.length, 1);
});

test("写接口内层拒绝不会被当作成功", async () => {
  const { api } = setup(({ method }) =>
    method === "get_song_detail_yqq"
      ? { track_info: { id: 123, mid: "mid", type: 1 } }
      : { retCode: 80092 },
  );
  await assert.rejects(api.tracks("0", ["mid"], true, true), /修改歌曲失败/);
});

test("缺失歌曲类型时不猜测，也不提交写入", async () => {
  const { api, calls } = setup(() => ({ track_info: { id: 123, mid: "mid" } }));
  await assert.rejects(api.tracks("0", ["mid"], true, true), /未提交修改/);
  assert.equal(calls.length, 1);
});

test("账号在读取过程中变化时阻止写入", async () => {
  const env = setup(() => {
    env.session.uin = "another";
    return { track_info: { id: 123, mid: "mid", type: 1 } };
  });
  await assert.rejects(env.api.tracks("0", ["mid"], true, true), /账号已切换/);
  assert.equal(env.calls.length, 1);
});

test("收藏接口失败列表优先于成功状态", async () => {
  const { api } = setup(() => ({ result: 0, v_failedPlaylistId: [123] }));
  await assert.rejects(api.subscribe("123", true), /收藏歌单失败/);
});

test("未登录与无效 ID 在请求前拒绝", async () => {
  const env = setup(() => ({}));
  await assert.rejects(env.api.subscribe("songMID", true), /ID 无效/);
  env.session.uin = "0";
  await assert.rejects(env.api.tracks("1", ["mid"], true), /请先登录/);
  assert.equal(env.calls.length, 0);
});

test("创建超时只尝试一次，不自动补发", async () => {
  const { api, calls } = setup(() => {
    throw new Error("timeout");
  });
  await assert.rejects(api.create("new"), /timeout/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { retry: false });
});

test("喜欢读取使用登录账号的加密 UIN 和实际分页偏移", async () => {
  const { api, calls } = setup(() => ({ songlist: [], total_song_num: 0, hasmore: 0 }));
  await api.detail("0", 100, true);
  assert.equal(calls[0].param.enc_host_uin, "encrypted");
  assert.equal(calls[0].param.song_begin, 100);
  assert.equal(calls[0].param.dirid, 201);
});

test("收藏歌单识别 name、cover 和 song_cnt 字段", async () => {
  const { api } = setup(() => ({
    v_list: [
      {
        id: 123,
        dirid: 7,
        name: "收藏的歌单",
        cover: "https://example.com/cover.jpg",
        song_cnt: 152,
        description: "简介",
      },
    ],
    hasmore: 0,
  }));
  const result = await api.favorites();
  assert.deepEqual(result.playlists[0], {
    id: "123",
    dirId: 7,
    name: "收藏的歌单",
    cover: "https://example.com/cover.jpg",
    trackCount: 152,
    description: "简介",
    owner: undefined,
  });
});

test("自建歌单保留小于 1000 的真实目录 ID", async () => {
  const { api } = setup(() => ({
    v_playlist: [
      { tid: 123, dirId: 7, dirName: "我的歌单" },
      { tid: 222, dirId: 201 },
      { tid: 999, dirId: 8, invalid: true },
    ],
  }));
  assert.deepEqual(
    (await api.created()).map((p) => p.id),
    ["123", "222"],
  );
});
