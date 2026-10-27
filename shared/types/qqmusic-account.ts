/** QQ 歌单公开 ID 与账号内目录 ID 必须分别保存。 */
export interface QQPlaylist {
  id: string;
  dirId: number;
  name: string;
  cover?: string;
  description?: string;
  owner?: string;
  trackCount: number;
}

export interface QQAccountSong {
  id: number;
  mid: string;
  type?: number;
  title?: string;
  name?: string;
  interval: number;
  singer?: Array<{ mid?: string; name?: string }>;
  album?: { mid?: string; name?: string };
  file?: { media_mid?: string; size_flac?: number; size_320mp3?: number; size_128mp3?: number };
  pay?: { payalbum?: number; payplay?: number };
}

export interface QQPlaylistPage {
  playlist?: QQPlaylist;
  songs: QQAccountSong[];
  total: number;
  hasMore: boolean;
}
