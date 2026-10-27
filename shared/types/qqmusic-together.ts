/** QQ 音乐官方一起听使用数字歌曲 ID，不使用播放用的 MID */
export interface QQTogetherSong {
  songID: number;
  songType: number;
  songIndex: number;
  title: string;
}

/** 当前仅保存已核实的房间同步字段 */
export interface QQTogetherHeartbeat {
  songInfo: {
    playingSongInfo?: QQTogetherSong;
    playStatus?: number;
    songOffset?: number;
    songPlayVersion?: number;
    songStartTime?: number;
  };
  mediaVersion?: number;
  playMode?: number;
  users: Array<{
    encryptUin?: string;
    nick?: string;
    nickname?: string;
    avatar?: string;
    headUrl?: string;
  }>;
  duration?: number;
  totalTime?: number;
  durationText?: string;
}

/** 一起听队列使用的最小 QQ 歌曲详情 */
export interface QQTogetherTrackInfo {
  id: number;
  type: number;
  mid: string;
  title: string;
  interval: number;
  singer?: Array<{ mid?: string; name: string }>;
  album?: { mid?: string; name?: string };
  file?: { media_mid?: string };
  pay?: { payplay?: number; payalbum?: number };
}
