"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createNightlyVersion } = require("../../scripts/gen-nightly-version.cjs");

test("稳定版的 Nightly 使用下一个补丁版本，允许更新器发现新构建", () => {
  assert.equal(createNightlyVersion("1.2.2", 500), "1.2.3-nightly.500");
  assert.equal(createNightlyVersion("1.2.9", 501), "1.2.10-nightly.501");
});

test("重复注入相同 Nightly 不再提高补丁号，预览版保留目标基线", () => {
  assert.equal(createNightlyVersion("1.2.3-nightly.500", 500), "1.2.3-nightly.500");
  assert.equal(createNightlyVersion("1.2.3-nightly.500", 501), "1.2.3-nightly.501");
  assert.equal(createNightlyVersion("1.3.0-beta.1", 502), "1.3.0-nightly.502");
});

test("拒绝无效版本和非正整数提交数", () => {
  for (const count of [0, -1, 1.5, NaN]) assert.throws(() => createNightlyVersion("1.2.2", count));
  for (const version of ["1.2", "invalid", "1.2.2-rc.1"])
    assert.throws(() => createNightlyVersion(version, 1));
});
