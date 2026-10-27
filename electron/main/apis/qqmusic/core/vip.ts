import type { QQMusicMembership } from "../../../../../shared/types/platform";

interface QQMusicVipIdentity {
  vip?: number;
  HugeVip?: number;
  huge_vip?: number;
  ExpVip?: number;
  exp_vip?: number;
  GroupVipFlag?: number;
  group_vip_flag?: number;
  CPLoverFlag?: number;
  cp_lover_flag?: number;
  level?: number;
}

export interface QQMusicVipData {
  svip?: number;
  identity?: QQMusicVipIdentity;
  userinfo?: {
    music_level?: number;
  };
}

/**
 * 将 QM 会员响应归一为播放权限状态
 * @param data - vip_login_base 响应
 * @returns 是否具有会员播放权限及会员等级
 */
export const normalizeQQMusicVip = (
  data: QQMusicVipData | null,
): { isVip: boolean; vipLevel: number; level?: number; membershipType: QQMusicMembership } => {
  const identity = data?.identity;
  const flags = [
    data?.svip,
    identity?.vip,
    identity?.HugeVip,
    identity?.huge_vip,
    identity?.ExpVip,
    identity?.exp_vip,
    identity?.GroupVipFlag,
    identity?.group_vip_flag,
    identity?.CPLoverFlag,
    identity?.cp_lover_flag,
  ];
  const isVip = flags.some((value) => Number(value) > 0);
  const vipLevel = Number(identity?.level ?? 0);
  const musicLevel = data?.userinfo?.music_level;
  const membershipType: QQMusicMembership = !data
    ? "unknown"
    : Number(data.svip) > 0
      ? "super"
      : Number(identity?.HugeVip ?? identity?.huge_vip) > 0
        ? "luxury"
        : Number(identity?.vip) > 0
          ? "green"
          : isVip
            ? "vip"
            : "none";
  return {
    isVip,
    vipLevel: Number.isSafeInteger(vipLevel) && vipLevel >= 0 ? vipLevel : 0,
    level:
      typeof musicLevel === "number" && Number.isSafeInteger(musicLevel) && musicLevel >= 0
        ? musicLevel
        : undefined,
    membershipType,
  };
};
