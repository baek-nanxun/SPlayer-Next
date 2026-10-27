import { startTogetherServer } from "../electron/main/services/together/room";

/** 独立房间服务入口，地址应为双方能够访问的 ws/wss 地址 */
const main = async (): Promise<void> => {
  const publicUrl = process.argv[2];
  const port = Number(process.argv[3] || 47158);
  if (
    !publicUrl ||
    !["ws:", "wss:"].includes(new URL(publicUrl).protocol) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("用法：node server.mjs ws://服务器地址:47158 [47158]");
  const server = await startTogetherServer(port);
  const invite =
    "splayer-together:" +
    Buffer.from(JSON.stringify({ url: publicUrl, secret: server.secret })).toString("base64url");
  console.log("双人一起听服务已启动，双方在播放器中粘贴下方邀请码加入：\n" + invite);
  /** 结束房间并释放监听端口 */
  const close = (): void => {
    server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
};
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
