import { qqmusicCall } from "@/apis/qqmusic";
import { qqSongToTrack } from "@/utils/format/qqmusic";
import type { QQPlaylist, QQPlaylistPage } from "@shared/types/qqmusic-account";
import type { Track } from "@shared/types/player";

export const qqAccount = <T>(action: string, params: Record<string, unknown> = {}): Promise<T> =>
  qqmusicCall<T>("account", { action, ...params });

/** 分页读取账号歌单，遇到异常分页时不把不完整数据作为完整歌单。 */
export const fetchQQAccountPlaylist = async (
  id: string,
  options: { liked?: boolean; signal?: AbortSignal; onBatch?: (tracks: Track[]) => void } = {},
): Promise<{ playlist?: QQPlaylist; tracks: Track[] }> => {
  const tracks: Track[] = [];
  let playlist: QQPlaylist | undefined;
  let offset = 0;
  const seen = new Set<string>();
  while (true) {
    options.signal?.throwIfAborted();
    const page = await qqAccount<QQPlaylistPage>("detail", { id, offset, liked: options.liked });
    options.signal?.throwIfAborted();
    playlist ??= page.playlist;
    const batch = page.songs.map((song) =>
      qqSongToTrack({
        id: String(song.id),
        mid: song.mid,
        name: song.title ?? song.name ?? "",
        artist: song.singer?.map((s) => s.name).join(" / ") ?? "",
        artists: song.singer,
        album: song.album?.name,
        albumMid: song.album?.mid,
        mediaMid: song.file?.media_mid,
        duration: song.interval * 1000,
        pay: song.pay,
        sizeFlac: song.file?.size_flac,
        size320: song.file?.size_320mp3,
        size128: song.file?.size_128mp3,
      }),
    );
    if (batch.length && batch.every((track) => seen.has(track.id)))
      throw new Error("QQ 音乐歌单重复分页，请重试");
    for (const track of batch) seen.add(track.id);
    tracks.push(...batch);
    options.onBatch?.(batch);
    offset += page.songs.length;
    if (!page.hasMore && offset >= page.total) break;
    if (!page.songs.length) throw new Error("QQ 音乐歌单分页不完整，请重试");
  }
  return { playlist, tracks };
};
