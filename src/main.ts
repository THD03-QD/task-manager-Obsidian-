import { Plugin } from "obsidian";
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

export default class TaskManager extends Plugin {
  centerTasks: Task[] = [];
  scanned: Task[] = [];

  async onload() {
    this.refreshFromDisk();

    this.registerView(VIEW_TYPE_TASK, (leaf) => new TaskView(leaf, this));

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

  refreshFromDisk() {
    this.centerTasks = loadCenter();
    this.scanned = scanAll();
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
    saveCenter(this.centerTasks);
    this.broadcastChange();
    return task;
  }

  async updateTask(id: string, patch: Partial<Omit<Task, "id" | "createdAt" | "source">>) {
    const exist = this.getAll().find((t) => t.id === id);
    if (!exist) return;
    const normalized = { ...patch, recur: (patch.recur as Recur) || undefined };
    this.centerTasks = this.centerTasks.filter((t) => t.id !== exist.id);
    this.centerTasks.push({ ...exist, ...normalized });
    saveCenter(this.centerTasks);
    this.broadcastChange();
  }

  async removeTask(id: string) {
    const exist = this.getAll().find((t) => t.id === id);
    this.centerTasks = this.centerTasks.filter((t) => t.id !== id);
    saveCenter(this.centerTasks);
    this.broadcastChange();
    // 说明：若删的是「笔记待办」且尚未进中心，下次扫描会重新发现；彻底删除需改源笔记。
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
    saveCenter(this.centerTasks);
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
