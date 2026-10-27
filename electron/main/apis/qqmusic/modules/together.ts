import { createQQTogetherApi } from "../core/together";
import { getQQMusicCookies, getQQMusicUin, qmRequest } from "../core/request";
import type { QMModule } from "../core/types";
const api = createQQTogetherApi(qmRequest, () => ({
  uin: getQQMusicUin(),
  musicKey: getQQMusicCookies().qm_keyst || getQQMusicCookies().qqmusic_key || "",
}));

/** QQ 官方一起听固定操作入口，不接受任意上游模块或其他用户身份
 * @param params - 明确操作与已校验参数
 */
const together: QMModule = async (params) => {
  switch (params.action) {
    case "create":
      return api.create(params.songs, params.index, params.position);
    case "join":
      return api.join(params.showID, params.fromEncryptedUin);
    case "heartbeat":
      return api.heartbeat(params.showID);
    case "playlist":
      return api.playlist(params.showID);
    case "control":
      return api.control(
        params.showID,
        params.command,
        params.songs,
        params.index,
        params.position,
      );
    case "quit":
      return api.quit(params.showID);
    default:
      throw new Error("QQ 音乐一起听操作无效");
  }
};
export default together;
