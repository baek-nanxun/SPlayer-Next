import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: {} as Record<string, string>,
  refresh: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fetch: vi.fn(),
  uin: 1,
}));
vi.mock("../core/request", () => ({
  getQQMusicCookies: () => mocks.cookies,
  getQQMusicUin: () => String(mocks.uin),
  refreshQMCredential: mocks.refresh,
}));
vi.mock("@main/utils/logger", () => ({
  coreLog: { debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: mocks.error },
}));
import songUrl from "./song_url";

beforeEach(() => {
  mocks.cookies = {};
  mocks.uin++;
  mocks.refresh.mockReset().mockResolvedValue(false);
  mocks.fetch.mockReset();
  mocks.warn.mockClear();
  mocks.error.mockClear();
  vi.stubGlobal("fetch", mocks.fetch);
});

it("HTTP 拒绝保留状态码，不把 HTML 拒绝页误报成 JSON 解析失败", async () => {
  mocks.fetch.mockResolvedValue(new Response("denied", { status: 403 }));
  const result = await songUrl({ mid: "MID", level: "hq" });
  expect(result).toMatchObject({ code: 403, data: [{ url: "" }] });
  expect(mocks.error.mock.calls[0]?.[1]?.message).toContain("HTTP 403");
  expect(mocks.fetch).toHaveBeenCalledOnce();
});

it("空地址记录官方返回码和认证状态，诊断不包含密钥、Cookie 或音源链接", async () => {
  mocks.cookies = { qm_keyst: "private-music-key" };
  mocks.fetch.mockResolvedValue(
    Response.json({
      code: 0,
      req_0: { code: 0, data: { midurlinfo: [{ result: 104003, filename: "M800media.mp3" }] } },
    }),
  );
  await songUrl({ mid: "MID", mediaMid: "media", level: "hq" });
  expect(mocks.warn).toHaveBeenCalledWith(
    "[qm-song-url] 官方接口未返回可播放地址",
    expect.objectContaining({
      authenticated: true,
      outerCode: 0,
      innerCode: 0,
      resultCodes: [104003],
    }),
  );
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("private-music-key");
  expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("Cookie");
});

it("有直链时仍按候选顺序返回，不输出失败诊断", async () => {
  mocks.fetch.mockResolvedValue(
    Response.json({
      code: 0,
      req_0: {
        code: 0,
        data: {
          sip: ["https://audio.example.com/"],
          midurlinfo: [{ filename: "M800media.mp3", purl: "track.mp3", result: 0 }],
        },
      },
    }),
  );
  expect(await songUrl({ mid: "MID", mediaMid: "media", level: "hq" })).toMatchObject({
    code: 200,
    data: [{ url: "https://audio.example.com/track.mp3", level: "hq" }],
  });
  expect(mocks.warn).not.toHaveBeenCalled();
});

it("连续空地址不会逐首反复刷新凭据，超过一分钟后才允许再次刷新", async () => {
  mocks.cookies = { qm_keyst: "test-key" };
  mocks.fetch.mockImplementation(async () =>
    Response.json({ code: 0, req_0: { code: 0, data: { midurlinfo: [] } } }),
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(100000);
  await songUrl({ mid: "one", level: "hq" });
  await songUrl({ mid: "two", level: "hq" });
  expect(mocks.refresh).toHaveBeenCalledOnce();
  clock.mockReturnValue(160001);
  await songUrl({ mid: "three", level: "hq" });
  expect(mocks.refresh).toHaveBeenCalledTimes(2);
  clock.mockRestore();
});

it("并发取源失败共用一次刷新，成功后各自只补发一次取源请求", async () => {
  mocks.cookies = { qm_keyst: "test-key" };
  mocks.fetch.mockImplementation(async () =>
    Response.json({ code: 0, req_0: { code: 0, data: { midurlinfo: [] } } }),
  );
  let complete!: (ok: boolean) => void;
  mocks.refresh.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        complete = resolve;
      }),
  );
  const first = songUrl({ mid: "one", level: "hq" });
  const second = songUrl({ mid: "two", level: "hq" });
  await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  complete(true);
  await Promise.all([first, second]);
  expect(mocks.fetch).toHaveBeenCalledTimes(4);
});
