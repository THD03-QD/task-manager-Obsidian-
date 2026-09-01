// fsbridge：类型 + 纯逻辑（两端共享）+ 桌面端 Node fs 扫描/中心文件读写。
//
// 双端兼容要点：
// - 顶层绝不 import "fs"/"path"（esbuild 会把 ESM import 提升到模块顶层，
//   产物变成顶层 require("fs")，移动端 Capacitor 环境无 Node，模块求值即崩）。
// - 桌面函数体内通过 lazyNode() 惰性取 fs/path；eval("require") 让 esbuild
//   完全不做静态解析与提升，require 留在运行时按需执行。
// - 移动端只 import 本文件的纯逻辑部分，永远不触发桌面分支。

// ---------- 桌面端惰性 Node 桥 ----------
/* eslint-disable @typescript-eslint/no-explicit-any */
function lazyNode(): { fs: any; path: any } {
  // require 写在函数体内 + esbuild external（builtin-modules）→ 打包产物里
  // require("fs") 原样保留在函数体内，运行时才解析；移动端不调用桌面分支，
  // 永远不会触发这行（Capacitor 环境无 Node 也不受影响）。
  return { fs: require("fs"), path: require("path") };
}

// ---------- 类型（集中于此，main/view 引用） ----------
export type Priority = "urgent" | "high" | "medium" | "low";
export type Status = "todo" | "doing" | "done";
export type Recur = "daily" | "weekly" | "monthly";

export const RECUR_LABEL: Record<Recur, string> = {
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
};

export type TaskSource =
  | { kind: "personal" }
  | { kind: "vault-plugin"; vault: string }
  | { kind: "note"; vault: string; notePath: string };

export interface Task {
  id: string;
  name: string;
  content: string;
  priority: Priority;
  status: Status;
  dueDate: string;
  tags: string[];
  createdAt: number;
  completedAt?: number;
  subtasks?: SubTask[];
  recur?: Recur;
  source: TaskSource;
}

export interface SubTask {
  id: string;
  name: string;
  content: string;
  priority: Priority;
  dueDate: string;
  done: boolean;
}

export interface NewTaskInput {
  name: string;
  priority: Priority;
  content: string;
  dueDate: string;
  tags: string[];
  recur?: "" | Recur;
}

// ---------- 路径常量 ----------
export const PLUGIN_ID = "task-manager";
/** 中心任务文件相对某 vault 根的路径（桌面/移动统一） */
export const CENTER_REL = "任务/tasks.json";
/** 扫描笔记时跳过的目录名（路径任一段命中即跳过） */
export const SKIP_DIRS = new Set([
  ".obsidian", ".git", "node_modules", ".trash", "99-归档", ".smart-env",
]);

/** 移动端用：相对路径（正斜杠）任一段命中 SKIP_DIRS 则跳过 */
export function isSkippedPath(relPath: string): boolean {
  return relPath.split("/").some((seg) => SKIP_DIRS.has(seg));
}

export interface CenterData {
  tasks: Task[];
  ignored: string[];
}

/** 共享：解析中心文件 JSON 文本（桌面/移动同一份逻辑） */
export function parseCenter(text: string): CenterData {
  try {
    const raw = JSON.parse(text) as { tasks?: Task[]; ignored?: string[] };
    return { tasks: raw.tasks ?? [], ignored: raw.ignored ?? [] };
  } catch {
    /* ignore */
  }
  return { tasks: [], ignored: [] };
}

/** 共享：把 v1 data.json 的 {tasks:[...]} 映射为 vault-plugin 来源任务 */
export function tasksFromDataJson(raw: { tasks?: any[] }, vaultName: string): Task[] {
  return (raw.tasks ?? []).map((t: any) => ({
    id: t.id ?? `vp_${hashString(vaultName + (t.name ?? ""))}`,
    name: t.name ?? "",
    content: t.content ?? "",
    priority: (t.priority as Priority) ?? "medium",
    status: (t.status as Status) ?? "todo",
    dueDate: t.dueDate ?? "",
    tags: t.tags ?? [],
    createdAt: t.createdAt ?? 0,
    source: { kind: "vault-plugin" as const, vault: vaultName },
  }));
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

// ==================== 以下为桌面端专用（Node fs，移动端不调用） ====================

// ---------- 扫描 vault ----------
export function findVaults(root: string): string[] {
  const { fs, path } = lazyNode();
  const acc: string[] = [];
  const walk = (dir: string) => {
    let entries: any[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (fs.existsSync(path.join(dir, ".obsidian"))) acc.push(dir);
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) {
        walk(path.join(dir, e.name));
      }
    }
  };
  walk(root);
  return acc;
}

function collectMd(vault: string): string[] {
  const { fs, path } = lazyNode();
  const acc: string[] = [];
  const walk = (dir: string) => {
    let entries: any[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) acc.push(p);
    }
  };
  walk(vault);
  return acc;
}

// ---------- 各库插件 data.json 的任务 ----------
function readDataJson(vault: string): Task[] {
  const { fs, path } = lazyNode();
  const f = path.join(vault, ".obsidian", "plugins", PLUGIN_ID, "data.json");
  try {
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, "utf8")) as { tasks?: any[] };
      return tasksFromDataJson(raw, path.basename(vault));
    }
  } catch {
    /* ignore */
  }
  return [];
}

// ---------- 解析 md 行里的 - [ ] 待办（从行尾往回读元数据） ----------
const PRIO_MAP: Record<string, Priority> = {
  "🔺": "urgent",
  "⏫": "high",
  "🔼": "medium",
  "🔽": "low",
  "⏬": "low",
};
const DATE_KEYS = new Set(["📅", "⏳", "🛫", "➕", "✅", "❌"]);
const TASK_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.*)$/;

export function detect(line: string, vault: string, notePath: string): Task | null {
  const m = line.match(TASK_LINE);
  if (!m) return null;
  const done = m[1] === "x" || m[1] === "X";
  const tokens = m[2].trim().split(/\s+/);
  let priority: Priority | undefined;
  const tags: string[] = [];
  const dates: Record<string, string> = {};
  let i = tokens.length - 1;
  for (; i >= 0; i--) {
    const tok = tokens[i];
    if (tok.startsWith("#")) {
      tags.unshift(tok.slice(1));
      continue;
    }
    if (PRIO_MAP[tok]) {
      priority = PRIO_MAP[tok];
      continue;
    }
    if (DATE_KEYS.has(tok) && i + 1 < tokens.length) {
      dates[tok] = tokens[i + 1];
      i--;
      continue;
    }
    break;
  }
  const description = tokens.slice(0, i + 1).join(" ");
  if (!description) return null;
  return {
    id: `note_${hashString(vault + "|" + notePath + "|" + description)}`,
    name: description,
    content: "",
    priority: priority ?? "medium",
    status: done ? "done" : "todo",
    dueDate: dates["📅"] ?? "",
    tags,
    createdAt: 0,
    source: { kind: "note", vault, notePath },
  };
}

function collectNoteTasks(vault: string): Task[] {
  const { fs, path } = lazyNode();
  const out: Task[] = [];
  for (const p of collectMd(vault)) {
    let content = "";
    try {
      content = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const rel = path.relative(vault, p).replace(/\\/g, "/");
    const vaultName = path.basename(vault);
    for (const line of content.split(/\r?\n/)) {
      const t = detect(line, vaultName, rel);
      if (t) out.push(t);
    }
  }
  return out;
}

// ---------- 扫描全部 vault → 所有插件任务 + 笔记待办（桌面跨库） ----------
export function scanAll(root: string): Task[] {
  const vaults = findVaults(root);
  const out: Task[] = [];
  for (const v of vaults) {
    out.push(...readDataJson(v));
    out.push(...collectNoteTasks(v));
  }
  return out;
}

// ---------- 中心文件读写（桌面，同步 fs） ----------
export function getCenterFile(root: string): string {
  const { path } = lazyNode();
  return path.join(root, "任务", "tasks.json");
}

export function loadCenter(root: string): CenterData {
  const { fs } = lazyNode();
  const f = getCenterFile(root);
  try {
    if (fs.existsSync(f)) {
      return parseCenter(fs.readFileSync(f, "utf8"));
    }
  } catch {
    /* ignore */
  }
  return { tasks: [], ignored: [] };
}

export function saveCenter(root: string, data: CenterData) {
  const { fs, path } = lazyNode();
  const f = getCenterFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(
    f,
    JSON.stringify({ tasks: data.tasks, ignored: data.ignored }, null, 2),
    "utf8"
  );
}

// ---------- 合并（中心为主 + 扫描补充，去重） ----------
export function keyOf(t: Task): string {
  if (t.source.kind === "note") return `note|${t.source.vault}|${t.source.notePath}|${t.name}`;
  if (t.source.kind === "vault-plugin") return `vp|${t.source.vault}|${t.id}`;
  return `personal|${t.id}`;
}

export function mergeTasks(
  center: Task[],
  scanned: Task[],
  ignored: string[] = []
): Task[] {
  const centerKeys = new Set(center.map(keyOf));
  const ignore = new Set(ignored);
  const result = [...center];
  for (const t of scanned) {
    const k = keyOf(t);
    if (ignore.has(k)) continue;
    if (!centerKeys.has(k)) result.push(t);
  }
  return result;
}

const PRIO_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export function compareTasks(a: Task, b: Task): number {
  const p = PRIO_RANK[a.priority] - PRIO_RANK[b.priority];
  if (p !== 0) return p;
  const d = (a.dueDate || "9999").localeCompare(b.dueDate || "9999");
  if (d !== 0) return d;
  return (a.createdAt || 0) - (b.createdAt || 0);
}

export function advanceDue(due: string, recur: Recur): string {
  const base = due ? new Date(due) : new Date();
  const d = new Date(base);
  if (recur === "daily") d.setDate(d.getDate() + 1);
  else if (recur === "weekly") d.setDate(d.getDate() + 7);
  else if (recur === "monthly") d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

// 兼容旧版子任务（{id,text,done}）→ 新结构（含 name/content/priority/dueDate）
export function normalizeTask(t: Task): Task {
  if (!t.subtasks || !t.subtasks.length) return t;
  const subtasks = t.subtasks.map((s) => {
    const anyS = s as any;
    if (anyS.text != null && s.name == null) {
      return {
        id: s.id,
        name: String(anyS.text),
        content: "",
        priority: "medium" as Priority,
        dueDate: "",
        done: s.done,
      };
    }
    return s;
  });
  return { ...t, subtasks };
}
