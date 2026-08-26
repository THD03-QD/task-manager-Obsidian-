// 把构建产物部署到指定知识库根目录下所有「含 .obsidian 的 vault」的 .obsidian/plugins/<id>
import { cpSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const PKG_ID = "task-manager";
const FILES = [
  ["dist/main.js", "main.js"],
  ["styles.css", "styles.css"],
  ["manifest.json", "manifest.json"],
];

// 通过环境变量 TASK_ROOT 指定知识库根目录，避免硬编码本机路径
const ROOT = process.env.TASK_ROOT || "";
const SKIP = new Set([".obsidian", ".git", "node_modules", ".trash", "99-归档"]);

function findVaults(root) {
  const acc = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (existsSync(join(dir, ".obsidian"))) acc.push(dir);
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name)) {
        walk(join(dir, e.name));
      }
    }
  };
  walk(root);
  return acc;
}

if (!ROOT) {
  console.error("未设置 TASK_ROOT 环境变量。示例: TASK_ROOT=\"D:/WenJian/knowledge\" node deploy.mjs");
  process.exit(1);
}
const vaults = findVaults(ROOT);
console.log("vaults:", vaults);
for (const v of vaults) {
  const dest = join(v, ".obsidian", "plugins", PKG_ID);
  mkdirSync(dest, { recursive: true });
  for (const [src, out] of FILES) {
    cpSync(src, join(dest, out));
  }
  console.log("deployed ->", dest);
}
console.log("done");
