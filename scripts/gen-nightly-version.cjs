#!/usr/bin/env node
"use strict";

const { execSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

/**
 * 生成高于当前稳定版的测试版本，重复注入时保留同一基线
 * @param {string} version - 源码版本
 * @param {number} count - Git 提交数
 * @returns {string} Nightly 版本
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- CJS 使用上方 JSDoc 声明返回类型
const createNightlyVersion = (version, count) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|nightly)(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match || !Number.isSafeInteger(count) || count <= 0) throw new Error("Nightly 版本参数无效");
  const patch = Number(match[3]) + (match[4] ? 0 : 1);
  return `${match[1]}.${match[2]}.${patch}-nightly.${count}`;
};

if (require.main === module) {
  const pkgPath = resolve(process.cwd(), "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  let commitCount = 0;
  try {
    commitCount = Number.parseInt(
      execSync("git rev-list --count HEAD", { encoding: "utf-8" }).trim(),
      10,
    );
  } catch (error) {
    console.error("[GenNightlyVersion] 错误：无法获取 git 提交次数", error);
    process.exit(1);
  }

  if (Number.isNaN(commitCount) || commitCount <= 0) {
    console.error(`[GenNightlyVersion] 错误：获取到的提交次数无效: ${commitCount}`);
    process.exit(1);
  }

  const nightlyVersion = createNightlyVersion(pkg.version, commitCount);
  pkg.version = nightlyVersion;

  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  console.log(`[GenNightlyVersion] 版本已更新为: ${nightlyVersion}`);
}

module.exports = { createNightlyVersion };
