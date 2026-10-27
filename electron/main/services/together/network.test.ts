import assert from "node:assert/strict";
import { test } from "node:test";
import type { NetworkInterfaceInfo } from "node:os";
import { selectTogetherAddress, togetherConnectionError } from "./network";

/** 构造测试网卡地址
 * @param address - IPv4 地址
 */
const entry = (address: string): NetworkInterfaceInfo => ({
  address,
  family: "IPv4",
  internal: false,
  netmask: "255.255.255.0",
  mac: "00:00:00:00:00:00",
  cidr: `${address}/24`,
});
// 使用虚构网卡地址，不包含人工联调设备的实际网络信息
const interfaces = {
  enp0: [entry("192.168.50.10")],
  tailscale0: [entry("100.64.0.10")],
  mihomo: [entry("198.18.0.1")],
};

test("异地建房优先选择 Tailscale，而非邀请码中无法跨网访问的局域网 IP", () => {
  assert.equal(selectTogetherAddress(interfaces), "100.64.0.10");
});
test("允许明确选择本机局域网地址", () => {
  assert.equal(selectTogetherAddress(interfaces, "192.168.50.10"), "192.168.50.10");
});
test("手动填写听友 IP 时提示使用房主本机地址", () => {
  assert.throws(() => selectTogetherAddress(interfaces, "100.64.0.20"), /这台电脑/);
  assert.throws(() => selectTogetherAddress(interfaces, "invalid"), /IPv4/);
});
test("没有 VPN 时选择局域网，只有代理 TUN 时回退环回", () => {
  assert.equal(
    selectTogetherAddress({ enp0: interfaces.enp0, mihomo: interfaces.mihomo }),
    "192.168.50.10",
  );
  assert.equal(selectTogetherAddress({ mihomo: interfaces.mihomo }), "127.0.0.1");
});
test("Windows 网卡名称同样识别 Tailscale", () => {
  assert.equal(
    selectTogetherAddress({ Ethernet: interfaces.enp0, Tailscale: interfaces.tailscale0 }),
    "100.64.0.10",
  );
});
test("连接诊断包含目标和具体原因，隐藏邀请码密钥", () => {
  const url = new URL("ws://100.64.0.10:34001");
  assert.match(
    togetherConnectionError(Object.assign(new Error("no"), { code: "ECONNREFUSED" }), url),
    /34001.*拒绝/,
  );
  assert.match(
    togetherConnectionError(new Error("Opening handshake has timed out"), url),
    /Tailscale/,
  );
  assert.match(
    togetherConnectionError(Object.assign(new Error("no"), { code: "EHOSTUNREACH" }), url),
    /VPN/,
  );
  assert.match(
    togetherConnectionError(Object.assign(new Error("no"), { code: "ENOTFOUND" }), url),
    /无法解析/,
  );
});
