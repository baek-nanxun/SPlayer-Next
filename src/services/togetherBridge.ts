import type { TogetherCommand } from "@shared/types/together";
let control: ((command: TogetherCommand) => void) | null = null;
/** 安装房间控制入口，离开后恢复单人播放
 * @param handler - 房间操作发送器
 */
export const setTogetherControl = (handler: typeof control): void => {
  control = handler;
};
/** 查询当前是否由房间管理播放 */
export const isTogetherActive = (): boolean => control !== null;
/** 将本地操作交给房间统一排序
 * @param command - 播放操作
 * @returns 是否已交给房间
 */
export const routeTogether = (command: TogetherCommand): boolean => {
  if (!control) return false;
  control(command);
  return true;
};
