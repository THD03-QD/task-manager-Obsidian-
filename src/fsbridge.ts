import * as fs from "fs";
import * as path from "path";

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
const PLUGIN_ID = "task-manager";
const SKIP_DIRS = new Set([
  ".obsidian", ".git", "node_modules", ".trash", "99-归档", ".smart-env",
]);

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

// ---------- 扫描 vault ----------
export function findVaults(root: string): string[] {
  const acc: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
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
  const acc: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
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
  const f = path.join(vault, ".obsidian", "plugins", PLUGIN_ID, "data.json");
  try {
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, "utf8")) as { tasks?: any[] };
      const vaultName = path.basename(vault);
      return (raw.tasks ?? []).map((t: any) => ({
        id: t.id ?? `vp_${hashString(vault + (t.name ?? ""))}`,
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

// ---------- 扫描全部 vault → 所有插件任务 + 笔记待办 ----------
export function scanAll(root: string): Task[] {
  const vaults = findVaults(root);
  const out: Task[] = [];
  for (const v of vaults) {
    out.push(...readDataJson(v));
    out.push(...collectNoteTasks(v));
  }
  return out;
}

// ---------- 中心文件读写 ----------
export function getCenterFile(root: string): string {
  return path.join(root, "任务", "tasks.json");
}

export interface CenterData {
  tasks: Task[];
  ignored: string[];
}

export function loadCenter(root: string): CenterData {
  const f = getCenterFile(root);
  try {
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, "utf8")) as {
        tasks?: Task[];
        ignored?: string[];
      };
      return { tasks: raw.tasks ?? [], ignored: raw.ignored ?? [] };
    }
  } catch {
    /* ignore */
  }
  return { tasks: [], ignored: [] };
}

export function saveCenter(root: string, data: CenterData) {
  const f = getCenterFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(
    f,
    JSON.stringify({ tasks: data.tasks, ignored: data.ignored }, null, 2),
    "utf8"
  );
}

export function centerFilePath(root: string): string {
  return getCenterFile(root);
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

// ---------- 导出：把任务写回某个 vault 的 md（追加/更新） ----------
export function appendToMarkdown(vault: string, relPath: string, task: Task): string {
  const full = path.join(vault, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const parts: string[] = [];
  if (task.dueDate) parts.push(`📅 ${task.dueDate}`);
  if (task.priority === "urgent") parts.push("🔺");
  else if (task.priority === "high") parts.push("⏫");
  else if (task.priority === "medium") parts.push("🔼");
  else parts.push("🔽");
  for (const tag of task.tags) parts.push(`#${tag}`);
  const line = `- [ ] ${task.name}${parts.length ? " " + parts.join(" ") : ""}`;
  let existing = "";
  try {
    existing = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
  } catch {
    /* ignore */
  }
  const updated = existing.trimEnd() + "\n\n## 导出任务\n" + line + "\n";
  fs.writeFileSync(full, updated, "utf8");
  return full;
}
