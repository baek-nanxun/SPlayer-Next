import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeQQMusicVip } from "./vip";

test("音乐等级和会员等级分别取值", () => {
  assert.deepEqual(
    normalizeQQMusicVip({ identity: { HugeVip: 1, level: 6 }, userinfo: { music_level: 12 } }),
    { isVip: true, vipLevel: 6, level: 12, membershipType: "luxury" },
  );
});
test("有音乐等级不代表开通会员，也不代表会员等级", () => {
  assert.deepEqual(normalizeQQMusicVip({ identity: { level: 0 }, userinfo: { music_level: 10 } }), {
    isVip: false,
    vipLevel: 0,
    level: 10,
    membershipType: "none",
  });
});
test("会员接口失败不能显示普通用户或伪造零级", () => {
  assert.deepEqual(normalizeQQMusicVip(null), {
    isVip: false,
    vipLevel: 0,
    level: undefined,
    membershipType: "unknown",
  });
});
test("超级会员优先于绿钻，兼容小写豪华绿钻字段", () => {
  assert.equal(
    normalizeQQMusicVip({ svip: 1, identity: { vip: 1, HugeVip: 1 } }).membershipType,
    "super",
  );
  assert.equal(normalizeQQMusicVip({ identity: { huge_vip: 1 } }).membershipType, "luxury");
});
test("缺失或非法音乐等级不回退为会员等级", () => {
  assert.equal(normalizeQQMusicVip({ identity: { level: 6 } }).level, undefined);
  assert.equal(normalizeQQMusicVip({ userinfo: { music_level: -1 } }).level, undefined);
});
