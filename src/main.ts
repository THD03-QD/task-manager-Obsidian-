/**
 * 任务管理插件：跨库总任务中心。
 * - 入口：注册视图 / 命令 / 设置页，加载任务数据
 * - 数据：读取中心 tasks.json + 扫描各库笔记待办(见 fsbridge.ts)
 * - 设置：可配置知识库根目录（留空 = 单库模式）
 */
import { App, Plugin, PluginSettingTab, Setting, FileSystemAdapter } from "obsidian";
import { TaskView, VIEW_TYPE_TASK } from "./view";
import {
  type Task,
  type NewTaskInput,
  type Priority,
  type Recur,
  scanAll,
  loadCenter,
  saveCenter,
  mergeTasks,
  compareTasks,
  normalizeTask,
  advanceDue,
} from "./fsbridge";

interface TaskSettings {
  /** 跨库检索的根目录，例如 D:\WenJian\knowledge；留空则只检索当前库 */
  rootPath: string;
}

const DEFAULT_SETTINGS: TaskSettings = { rootPath: "" };

export default class TaskManager extends Plugin {
  settings: TaskSettings = { ...DEFAULT_SETTINGS };
  centerTasks: Task[] = [];
  scanned: Task[] = [];

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.refreshFromDisk();

    this.registerView(VIEW_TYPE_TASK, (leaf) => new TaskView(leaf, this));
    this.addSettingTab(new TaskSettingTab(this.app, this));

    this.addRibbonIcon("check-square", "任务管理", () => this.openTaskView());

    this.addCommand({
      id: "open-task-manager",
      name: "打开任务管理",
      callback: () => this.openTaskView(),
    });

    this.addCommand({
      id: "rescan-tasks",
      name: "重新扫描全部任务",
      callback: () => this.refreshFromDisk(),
    });
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TASK);
  }

  /** 知识库根：优先用户设置，否则用当前库根（单库模式） */
  getRoot(): string {
    if (this.settings.rootPath) return this.settings.rootPath;
    if (this.app.vault.adapter instanceof FileSystemAdapter) {
      return this.app.vault.adapter.getBasePath();
    }
    return "";
  }

  refreshFromDisk() {
    const root = this.getRoot();
    this.centerTasks = loadCenter(root);
    this.scanned = scanAll(root);
    this.broadcastChange();
  }

  getAll(): Task[] {
    return mergeTasks(this.centerTasks, this.scanned)
      .map(normalizeTask)
      .sort(compareTasks);
  }

  openTaskView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASK)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf(true);
      void leaf.setViewState({ type: VIEW_TYPE_TASK, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async addTask(input: NewTaskInput): Promise<Task> {
    const task: Task = {
      id: `personal_${Date.now()}`,
      status: "todo",
      createdAt: Date.now(),
      ...input,
      recur: (input.recur as Recur) || undefined,
      source: { kind: "personal" },
    };
    this.centerTasks.push(task);
    saveCenter(this.getRoot(), this.centerTasks);
    this.broadcastChange();
    return task;
  }

  async updateTask(id: string, patch: Partial<Omit<Task, "id" | "createdAt" | "source">>) {
    const exist = this.getAll().find((t) => t.id === id);
    if (!exist) return;
    const normalized = { ...patch, recur: (patch.recur as Recur) || undefined };
    this.centerTasks = this.centerTasks.filter((t) => t.id !== exist.id);
    this.centerTasks.push({ ...exist, ...normalized });
    saveCenter(this.getRoot(), this.centerTasks);
    this.broadcastChange();
  }

  async removeTask(id: string) {
    const exist = this.getAll().find((t) => t.id === id);
    this.centerTasks = this.centerTasks.filter((t) => t.id !== id);
    saveCenter(this.getRoot(), this.centerTasks);
    this.broadcastChange();
    void exist;
  }

  async cycleStatus(id: string) {
    const t = this.getAll().find((x) => x.id === id);
    if (!t) return;
    const next: Record<Task["status"], Task["status"]> = {
      todo: "doing",
      doing: "done",
      done: "todo",
    };
    const status = next[t.status];
    await this.updateTask(id, {
      status,
      completedAt: status === "done" ? Date.now() : undefined,
    });
    if (status === "done" && t.recur) {
      this.spawnNext(t);
    }
  }

  private spawnNext(source: Task) {
    const copy: Task = {
      id: `personal_${Date.now()}`,
      name: source.name,
      content: source.content,
      priority: source.priority,
      status: "todo",
      dueDate: advanceDue(source.dueDate, source.recur as Recur),
      tags: [...source.tags],
      createdAt: Date.now(),
      completedAt: undefined,
      subtasks: source.subtasks
        ? source.subtasks
            .filter((s) => !s.done)
            .map((s) => ({
              ...s,
              id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            }))
        : undefined,
      recur: source.recur,
      source: { kind: "personal" },
    };
    this.centerTasks = [...this.centerTasks.filter((x) => x.id !== copy.id), copy];
    saveCenter(this.getRoot(), this.centerTasks);
    this.broadcastChange();
  }

  async addSubtask(
    taskId: string,
    input: { name: string; content: string; priority: Priority; dueDate: string }
  ) {
    const t = this.getAll().find((x) => x.id === taskId);
    if (!t) return;
    const subtasks = [
      ...(t.subtasks ?? []),
      { id: `sub_${Date.now()}`, ...input, done: false },
    ];
    await this.updateTask(taskId, { subtasks });
  }

  async updateSubtask(
    taskId: string,
    subId: string,
    patch: Partial<{ name: string; content: string; priority: Priority; dueDate: string }>
  ) {
    const t = this.getAll().find((x) => x.id === taskId);
    if (!t) return;
    const subtasks = (t.subtasks ?? []).map((s) =>
      s.id === subId ? { ...s, ...patch } : s
    );
    await this.updateTask(taskId, { subtasks });
  }

  async toggleSubtask(taskId: string, subId: string) {
    const t = this.getAll().find((x) => x.id === taskId);
    if (!t) return;
    const subtasks = (t.subtasks ?? []).map((s) =>
      s.id === subId ? { ...s, done: !s.done } : s
    );
    await this.updateTask(taskId, { subtasks });
  }

  async removeSubtask(taskId: string, subId: string) {
    const t = this.getAll().find((x) => x.id === taskId);
    if (!t) return;
    const subtasks = (t.subtasks ?? []).filter((s) => s.id !== subId);
    await this.updateTask(taskId, { subtasks });
  }

  private broadcastChange() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_TASK).forEach((leaf) => {
      if (leaf.view instanceof TaskView) {
        leaf.view.refresh();
      }
    });
  }
}

class TaskSettingTab extends PluginSettingTab {
  plugin: TaskManager;

  constructor(app: App, plugin: TaskManager) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "任务管理" });
    new Setting(containerEl)
      .setName("知识库根目录")
      .setDesc(
        "跨库检索的根路径（例如 D:\\WenJian\\knowledge）。留空则只检索当前打开的库（单库模式）。"
      )
      .addText((text) =>
        text
          .setPlaceholder("D:\\WenJian\\knowledge")
          .setValue(this.plugin.settings.rootPath)
          .onChange(async (value) => {
            this.plugin.settings.rootPath = value.trim();
            await this.plugin.saveSettings();
            this.plugin.refreshFromDisk();
          })
      );
  }
}
