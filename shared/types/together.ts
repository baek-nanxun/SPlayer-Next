import type { RepeatMode, ShuffleMode, Track } from "./player";

/** 共享队列和单帧大小保持有界，覆盖普通大型歌单 */
export const TOGETHER_MAX_TRACKS = 2000;
export const TOGETHER_MAX_PAYLOAD = 2 * 1024 * 1024;

/** 房间只传歌曲身份与展示资料，音源由各自账号获取 */
export type TogetherTrack = Pick<
  Track,
  | "id"
  | "extId"
  | "mediaId"
  | "source"
  | "title"
  | "artists"
  | "album"
  | "duration"
  | "cover"
  | "fee"
>;
export type TogetherCommand =
  | { type: "play" | "pause" | "next" | "prev" }
  | { type: "seek"; position: number }
  | { type: "mode"; shuffleMode?: ShuffleMode; repeatMode?: RepeatMode }
  | { type: "queue"; tracks: TogetherTrack[]; index: number }
  | { type: "enqueue"; tracks: TogetherTrack[]; position: "next" | "end" }
  | { type: "playTrack"; track: TogetherTrack }
  | { type: "remove"; track: Pick<TogetherTrack, "id" | "source"> }
  | {
      type: "move";
      track: Pick<TogetherTrack, "id" | "source">;
      before: Pick<TogetherTrack, "id" | "source"> | null;
    }
  | { type: "clear" };
export interface TogetherSnapshot {
  revision: number;
  queueRevision: number;
  shuffleMode?: ShuffleMode;
  repeatMode?: RepeatMode;
  serverTime: number;
  position: number;
  playing: boolean;
  desiredPlaying: boolean;
  index: number;
  tracks: TogetherTrack[];
  members: Array<{ id: string; name: string; online: boolean; ready: boolean; avatar?: string }>;
  elapsedMs: number;
  counting: boolean;
  chat: Array<{ id: number; senderId?: string; name: string; text: string }>;
}
export interface TogetherInitialState {
  tracks: TogetherTrack[];
  index: number;
  position?: number;
  playing?: boolean;
  shuffleMode?: ShuffleMode;
  repeatMode?: RepeatMode;
}

/**
 * 校验曲目是否满足一起听在线共享条件
 * @param track - 待检查的曲目
 * @param mode - 当前房间模式
 * @returns 曲目是否可在目标房间中共享
 */
export const isShareableTogetherTrack = (
  track: Partial<TogetherTrack> | null | undefined,
  mode?: "self" | "netease" | "qqmusic",
): track is TogetherTrack => {
  if (
    !track ||
    typeof track.id !== "string" ||
    !/^[a-zA-Z0-9]+$/.test(track.id) ||
    track.id.length > 80 ||
    typeof track.title !== "string" ||
    typeof track.duration !== "number" ||
    !Number.isFinite(track.duration) ||
    track.duration <= 0 ||
    track.duration > 86400000
  ) {
    return false;
  }
  if (mode === "qqmusic") return track.source === "qqmusic";
  if (mode === "netease") return track.source === "netease";
  return track.source === "qqmusic" || track.source === "netease";
};

export interface TogetherStatus {
  memberId?: string;
  mode?: "self" | "netease" | "qqmusic";
  connection: "idle" | "connecting" | "connected" | "reconnecting";
  invite: string;
  appInvite?: string;
  hosting: boolean;
  error: string;
  snapshot: TogetherSnapshot | null;
}
