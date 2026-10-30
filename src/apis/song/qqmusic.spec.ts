import { beforeEach, expect, it, vi } from "vitest";
import { ErrorCode } from "@shared/types/errors";
const call = vi.hoisted(() => vi.fn());
vi.mock("@/apis/qqmusic", () => ({ qqmusicCall: call }));
import { resolveQQMusicUrl } from "./qqmusic";
const track = {
  id: "MID",
  mediaId: "media",
  source: "qqmusic" as const,
  title: "忘记时间",
  artists: [],
  duration: 272000,
};
beforeEach(() => call.mockReset());

it("官方空地址不直接断言账号非会员，保留独立的歌曲不可用原因", async () => {
  call.mockResolvedValue({ code: 403, data: [{ url: "" }] });
  expect(await resolveQQMusicUrl(track, "hq")).toEqual({
    available: false,
    errorCode: ErrorCode.QQMUSIC_UNAVAILABLE,
  });
});

it("取源网络异常与歌曲不可用分开，成功仍沿用原始 MID 和媒体 MID", async () => {
  call.mockResolvedValueOnce({ code: 502, data: [{ url: "" }] });
  expect(await resolveQQMusicUrl(track, "hq")).toEqual({
    available: false,
    errorCode: ErrorCode.NETWORK_ERROR,
  });
  call.mockResolvedValueOnce({ code: 200, data: [{ url: "https://audio.example.com/a.mp3" }] });
  expect(await resolveQQMusicUrl(track, "hq")).toMatchObject({ available: true });
  expect(call).toHaveBeenLastCalledWith("song_url", { mid: "MID", mediaMid: "media", level: "hq" });
});
