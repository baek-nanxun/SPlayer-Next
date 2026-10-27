import songList from "./song_list";
import type { QQPlaylistPage } from "@shared/types/qqmusic-account";
import { createQQLibrary } from "../core/library";
import { getQQMusicCookies, getQQMusicUin, qmRequest } from "../core/request";
import type { QMModule } from "../core/types";

const library = createQQLibrary(qmRequest, () => {
  const cookies = getQQMusicCookies();
  const hasKey = !!(cookies.qm_keyst || cookies.qqmusic_key || cookies.p_skey || cookies.skey);
  return { uin: hasKey ? getQQMusicUin() : "0", euin: cookies.euin ?? "" };
});

/** 账号接口只暴露固定操作，不接受任意上游模块或用户身份。 */
export const account: QMModule = async (params) => {
  const offset = Number(params.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("分页参数无效");
  switch (params.action) {
    case "created":
      return library.created();
    case "favorites":
      return library.favorites(offset);
    case "detail": {
      try {
        return await library.detail(params.id, offset, params.liked === true);
      } catch (error) {
        // 部分账号的 CgiGetDiss 返回 10000，已有网页歌单接口仍能完整读取。
        if (!(error instanceof Error) || !error.message.includes("code=10000")) throw error;
        const id =
          params.liked === true
            ? (await library.created()).find((p) => p.dirId === 201)?.id
            : params.id;
        if (!id) throw error;
        const result = (await songList({ id })) as {
          code: number;
          id: string;
          name: string;
          cover?: string;
          description?: string;
          creator?: string;
          total: number;
          songs?: Array<{
            id: string;
            mid: string;
            name: string;
            duration: number;
            artists?: Array<{ mid?: string; name?: string }>;
            album?: string;
            albumMid?: string;
            mediaMid?: string;
            pay?: { payalbum?: number; payplay?: number };
            sizeFlac?: number;
            size320?: number;
            size128?: number;
          }>;
        };
        if (
          result.code !== 200 ||
          !Array.isArray(result.songs) ||
          result.songs.length < result.total
        )
          throw new Error("QQ 音乐网页歌单返回不完整，请重试");
        const page: QQPlaylistPage = {
          playlist: {
            id: String(result.id),
            dirId: params.liked === true ? 201 : 0,
            name: result.name,
            cover: result.cover,
            description: result.description,
            owner: result.creator,
            trackCount: result.total,
          },
          total: result.total,
          hasMore: false,
          songs: result.songs.slice(offset).map((s) => ({
            id: Number(s.id),
            mid: s.mid,
            title: s.name,
            interval: s.duration / 1000,
            singer: s.artists,
            album: { mid: s.albumMid, name: s.album },
            pay: s.pay,
            file: {
              media_mid: s.mediaMid,
              size_flac: s.sizeFlac,
              size_320mp3: s.size320,
              size_128mp3: s.size128,
            },
          })),
        };
        return page;
      }
    }
    case "create":
      return library.create(params.name);
    case "delete":
      await library.delete(params.id);
      break;
    case "tracks":
      if (typeof params.add !== "boolean") throw new Error("歌曲操作参数无效");
      await library.tracks(params.id, params.mids, params.add, params.liked === true);
      break;
    case "subscribe":
      if (typeof params.subscribe !== "boolean") throw new Error("收藏操作参数无效");
      await library.subscribe(params.id, params.subscribe);
      break;
    default:
      throw new Error("未知 QQ 音乐账号操作");
  }
  return { success: true };
};
