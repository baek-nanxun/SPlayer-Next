import type { NetworkInterfaceInfo } from "node:os";
import { isIP } from "node:net";

type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;

/** 选择建房地址，优先使用 Tailscale，手动地址必须属于本机
 * @param interfaces - 系统网卡及地址
 * @param requested - 用户指定的本机 IPv4 地址
 * @returns 可放入邀请码的房间地址
 */
export const selectTogetherAddress = (interfaces: Interfaces, requested?: string): string => {
  const addresses = Object.entries(interfaces).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal)
      .map((entry) => ({ name, address: entry.address })),
  );
  if (requested) {
    if (isIP(requested) !== 4) throw new Error("请输入本机 IPv4 地址");
    if (requested !== "127.0.0.1" && !addresses.some((entry) => entry.address === requested))
      throw new Error("请填写创建房间这台电脑的 IP，而不是听友的 IP");
    return requested;
  }
  const vpn = addresses.find((entry) => /tailscale/i.test(entry.name));
  return (
    vpn?.address ??
    addresses.find((entry) => entry.address.startsWith("192.168."))?.address ??
    addresses.find((entry) => entry.address.startsWith("10."))?.address ??
    addresses.find((entry) => !entry.address.startsWith("198.18."))?.address ??
    "127.0.0.1"
  );
};

/** 将握手错误变成可操作的连接提示，不显示房间密钥
 * @param error - 网络连接错误
 * @param endpoint - 房间服务地址
 */
export const togetherConnectionError = (error: Error, endpoint: URL): string => {
  const code = (error as NodeJS.ErrnoException).code;
  const target = endpoint.host;
  if (code === "ECONNREFUSED") return `房间 ${target} 拒绝连接，请确认房间仍在运行及端口正确`;
  if (code === "ETIMEDOUT" || /timed out|timeout/i.test(error.message))
    return `连接 ${target} 超时；异地请使用房主的 Tailscale／VPN 地址，并检查房间端口`;
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH")
    return `无法到达 ${target}，请检查 VPN 连接及邀请码中的地址`;
  if (code === "ENOTFOUND") return `无法解析房间地址 ${endpoint.hostname}`;
  return `连接 ${target} 失败，请确认双方的 VPN 和房间端口可达${code ? `（${code}）` : ""}`;
};
