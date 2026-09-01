// mobile-io：移动端 IO 层。全部走 Obsidian vault/adapter API，零 Node 依赖。
// 与桌面端(fsbridge)语义对齐：
// - 中心文件同为 <vault>/任务/tasks.json（adapter 相对路径读写）
// - 扫描同为「当前库 data.json 的 v1 任务 + 当前库笔记 - [ ] 待办」
import { App, normalizePath, type DataAdapter } from "obsidian";
import {
  CENTER_REL,
  detect,
  isSkippedPath,
  parseCenter,
  tasksFromDataJson,
  type CenterData,
  type Task,
} from "./fsbridge";

/** 读中心任务文件（不存在/损坏返回空） */
export async function loadCenterMobile(adapter: DataAdapter): Promise<CenterData> {
  const rel = normalizePath(CENTER_REL);
  try {
    if (await adapter.exists(rel)) {
      return parseCenter(await adapter.read(rel));
    }
  } catch {
    /* ignore */
  }
  return { tasks: [], ignored: [] };
}

/** 写中心任务文件（目录不存在则先建） */
export async function saveCenterMobile(adapter: DataAdapter, data: CenterData): Promise<void> {
  const rel = normalizePath(CENTER_REL);
  try {
    await adapter.mkdir(normalizePath("任务"));
  } catch {
    /* 已存在等情况忽略 */
  }
  await adapter.write(
    rel,
    JSON.stringify({ tasks: data.tasks, ignored: data.ignored }, null, 2)
  );
}

/**
 * 扫描当前库：v1 data.json 旧任务（vault-plugin 来源）+ 笔记 - [ ] 待办（note 来源）。
 * pluginData 传 plugin.loadData() 的原始结果（v1 把任务存在 data.json 的 tasks 字段）。
 */
export async function scanCurrentVault(app: App, pluginData: unknown): Promise<Task[]> {
  const vault = app.vault;
  const vaultName = vault.getName();
  const out: Task[] = [];

  const raw = pluginData as { tasks?: any[] } | null;
  if (raw && Array.isArray(raw.tasks) && raw.tasks.length) {
    out.push(...tasksFromDataJson(raw, vaultName));
  }

  for (const f of vault.getMarkdownFiles()) {
    if (isSkippedPath(f.path)) continue;
    let content = "";
    try {
      content = await vault.cachedRead(f);
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const t = detect(line, vaultName, f.path);
      if (t) out.push(t);
    }
  }
  return out;
}
