import { Agent, fetch as undiciFetch } from "undici";
import { connect, checkServerIdentity } from "node:tls";
import { fetchWithProxy } from "@main/utils/proxy";

/** 保留本机既有的网易云连接修复：不发送 SNI，但仍验证原始域名及证书链。 */
const hosts = new Set([
  "interface.music.163.com",
  "interface3.music.163.com",
  "interfacepc.music.163.com",
  "clientlog.music.163.com",
  "clientlog3.music.163.com",
]);
const agent = new Agent({
  connections: 2,
  maxOrigins: hosts.size,
  connect(options, callback) {
    const hostname = options.hostname;
    if (options.protocol !== "https:" || !hosts.has(hostname)) {
      callback(new Error("Unexpected NetEase TLS destination"), null);
      return;
    }
    const socket = connect({
      host: hostname,
      port: Number(options.port) || 443,
      servername: "",
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"],
      checkServerIdentity: (_, cert) => checkServerIdentity(hostname, cert),
    });
    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      if (error) callback(error, null);
      else callback(null, socket);
    };
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60000);
    socket.setTimeout(8000, () => socket.destroy(new Error("NetEase TLS connection timeout")));
    socket.once("secureConnect", () => finish(null));
    socket.once("error", finish);
    return socket;
  },
});

/** 仅对原安装中指定的网易云域名使用直连修复。 */
export const fetchNeteaseDirect = (url: string | URL, init?: RequestInit): Promise<Response> => {
  if (!hosts.has(new URL(url).hostname)) return fetchWithProxy(url, init);
  return undiciFetch(url, { ...init, dispatcher: agent } as Parameters<
    typeof undiciFetch
  >[1]) as unknown as Promise<Response>;
};
