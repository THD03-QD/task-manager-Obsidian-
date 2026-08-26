/**
 * 任务管理视图层：总览列表(按来源分组) / 看板(拖拽) / 统计，以及任务详情、右键菜单与弹窗。
 * 数据由 TaskManager(main.ts) 提供，本模块只做展示与用户交互。
 */
import { App, ItemView, Modal, Notice, Menu, TFile, type WorkspaceLeaf } from "obsidian";
import type TaskManager from "./main";
import type { Task, Priority, Status, NewTaskInput, SubTask, Recur } from "./fsbridge";
import { RECUR_LABEL } from "./fsbridge";

export const VIEW_TYPE_TASK = "task-manager-view";

const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

const PRIORITY_ORDER: Priority[] = ["urgent", "high", "medium", "low"];

const COLUMNS: { key: Status; label: string }[] = [
  { key: "todo", label: "📋 待办" },
  { key: "doing", label: "🔄 进行中" },
  { key: "done", label: "✅ 完成" },
];

const STATUS_LABEL: Record<Status, string> = {
  todo: "待办",
  doing: "进行中",
  done: "已完成",
};

function sourceLabel(t: Task): string {
  if (t.source.kind === "personal") return "🧑 个人任务";
  if (t.source.kind === "vault-plugin") return `📚 ${t.source.vault}`;
  const noteFile = t.source.notePath.split("/").pop() ?? t.source.notePath;
  return `📚 ${t.source.vault} · ${noteFile}`;
}

function baseName(p: string): string {
  return p.split("/").pop() ?? p;
}

interface TaskGroup {
  key: string;
  label: string;
  tasks: Task[];
}

// 按来源分组：个人任务排最前，其余按库名（首现顺序）
function groupTasks(tasks: Task[]): TaskGroup[] {
  const order: string[] = [];
  const map = new Map<string, TaskGroup>();
  const personal: TaskGroup = { key: "__personal__", label: "🧑 个人任务", tasks: [] };
  map.set("__personal__", personal);
  for (const t of tasks) {
    let key = "__personal__";
    let label = "🧑 个人任务";
    if (t.source.kind !== "personal") {
      key = t.source.vault;
      label = `📚 ${t.source.vault}`;
    }
    if (!map.has(key)) {
      map.set(key, { key, label, tasks: [] });
      order.push(key);
    }
    map.get(key)!.tasks.push(t);
  }
  const result: TaskGroup[] = [];
  if (personal.tasks.length) result.push(personal);
  for (const k of order) result.push(map.get(k)!);
  return result;
}

function buildWeeks(tasks: Task[]): { label: string; count: number }[] {
  const arr: { label: string; count: number }[] = [];
  const now = new Date();
  for (let i = 7; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7 * i);
    const end = start.getTime() + 7 * 86400000;
    const count = tasks.filter((t) => {
      if (!t.completedAt) return false;
      return t.completedAt >= start.getTime() && t.completedAt < end;
    }).length;
    arr.push({ label: `${start.getMonth() + 1}/${start.getDate()}`, count });
  }
  return arr;
}

export class TaskView extends ItemView {
  private plugin: TaskManager;
  currentTaskId: string | null = null;
  private collapsed: Set<string> = new Set();
  private viewMode: "list" | "board" | "stats" = "list";
  private dragId: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: TaskManager) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_TASK;
  }

  getDisplayText() {
    return "任务管理";
  }

  getIcon() {
    return "check-square";
  }

  async onOpen() {
    this.refresh();
    this.notifyDue();
  }

  private notifyDue() {
    const today = new Date().toISOString().slice(0, 10);
    const all = this.plugin.getAll();
    const due = all.filter((t) => t.status !== "done" && t.dueDate === today).length;
    const overdue = all.filter(
      (t) => t.status !== "done" && !!t.dueDate && t.dueDate < today
    ).length;
    if (due || overdue) {
      new Notice(`今日到期 ${due} 项，逾期 ${overdue} 项`);
    }
  }

  async onClose() {
    this.contentEl.empty();
  }

  refresh() {
    const id = this.currentTaskId;
    if (id) {
      this.renderDetail(id);
    } else if (this.viewMode === "board") {
      this.renderBoard();
    } else if (this.viewMode === "stats") {
      this.renderStats();
    } else {
      this.renderList();
    }
  }

  private renderList() {
    const container = this.contentEl;
    container.empty();
    container.addClass("task-view");

    const toolbar = container.createDiv({ cls: "task-toolbar" });
    const head = toolbar.createDiv({ cls: "task-toolbar-head" });
    head.createEl("h2", { text: "任务总览" });
    const counts = container.createDiv({ cls: "task-counts" });
    const all = this.plugin.getAll();
    const open = all.filter((t) => t.status === "todo").length;
    counts.setText(`未完成 ${open} / 共 ${all.length} 条`);
    const addBtn = toolbar.createEl("button", { text: "＋ 添加任务", cls: "mod-cta" });
    addBtn.addEventListener("click", () => this.openAddModal());
    const boardBtn = toolbar.createEl("button", { text: "看板" });
    boardBtn.addEventListener("click", () => {
      this.viewMode = "board";
      this.refresh();
    });
    const statsBtn = toolbar.createEl("button", { text: "统计" });
    statsBtn.addEventListener("click", () => {
      this.viewMode = "stats";
      this.refresh();
    });
    const rescanBtn = toolbar.createEl("button", { text: "重新扫描" });
    rescanBtn.addEventListener("click", () => {
      this.plugin.refreshFromDisk();
      new Notice("已重新扫描全部知识库任务");
    });

    const list = container.createDiv({ cls: "task-list" });

    if (all.length === 0) {
      container.createDiv({
        cls: "task-empty",
        text: "暂无任务。点「＋ 添加任务」创建，或到插件设置里配置「知识库根目录」以跨库检索。",
      });
      return;
    }

    for (const g of groupTasks(all)) {
      const opened = !this.collapsed.has(g.key);
      const header = list.createDiv({ cls: "task-group-header" });
      header.setText(`${opened ? "▾" : "▸"} ${g.label} · ${g.tasks.length} 条`);
      header.addEventListener("click", () => {
        if (this.collapsed.has(g.key)) {
          this.collapsed.delete(g.key);
        } else {
          this.collapsed.add(g.key);
        }
        this.refresh();
      });
      if (opened) {
        for (const t of g.tasks) {
          this.renderCard(list, t);
        }
      }
    }
  }

  private renderCard(list: HTMLElement, t: Task, draggable = false) {
    const today = new Date().toISOString().slice(0, 10);
    const overdue = t.status !== "done" && !!t.dueDate && t.dueDate < today;
    const dueToday = t.status !== "done" && t.dueDate === today;
    const card = list.createDiv({
      cls: `task-card priority-${t.priority}${t.status === "done" ? " is-done" : ""}${overdue ? " is-overdue" : ""}${dueToday ? " is-due" : ""}`,
    });

    if (draggable) {
      card.setAttr("draggable", "true");
      card.addEventListener("dragstart", () => {
        this.dragId = t.id;
      });
      card.addEventListener("dragend", () => {
        this.dragId = null;
      });
    }

    const cb = card.createEl("input", { type: "checkbox", cls: "task-checkbox" });
    cb.checked = t.status === "done";
    cb.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.plugin.cycleStatus(t.id);
    });

    const body = card.createDiv({ cls: "task-card-body" });
    body.createDiv({ cls: "task-source", text: sourceLabel(t) });
    body.createDiv({ cls: "task-card-name", text: t.name });

    if (t.content) {
      body.createDiv({ cls: "task-card-summary", text: t.content });
    }

    const meta = body.createDiv({ cls: "task-card-meta" });
    const bits: string[] = [];
    if (t.tags.length) bits.push(t.tags.map((x) => `#${x}`).join("  "));
    if (t.dueDate) bits.push(`📅 ${t.dueDate}`);
    if (t.recur) bits.push(`🔁 ${RECUR_LABEL[t.recur]}`);
    if (t.subtasks && t.subtasks.length) {
      const d = t.subtasks.filter((s) => s.done).length;
      bits.push(`☑ ${d}/${t.subtasks.length}`);
    }
    if (bits.length) meta.setText(bits.join("   "));

    card.addEventListener("click", () => {
      if (this.dragId) return;
      this.currentTaskId = t.id;
      this.refresh();
    });

    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openCardMenu(e, t);
    });
  }

  private openCardMenu(e: MouseEvent, t: Task) {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(t.status === "done" ? "重置为待办" : "标记完成")
        .setIcon(t.status === "done" ? "rotate-ccw" : "check")
        .onClick(() => void this.plugin.cycleStatus(t.id))
    );
    menu.addItem((item) =>
      item
        .setTitle("编辑")
        .setIcon("pencil")
        .onClick(() => {
          new AddTaskModal(this.app, async (r) => {
            await this.plugin.updateTask(t.id, { ...r, recur: (r.recur as Recur) || undefined });
            this.refresh();
          }, t).open();
        })
    );
    if (t.source.kind === "note") {
      menu.addItem((item) =>
        item.setTitle("打开所在笔记").setIcon("file-text").onClick(() => this.openSourceNote(t))
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("删除")
        .setIcon("trash")
        .onClick(async () => {
          await this.plugin.removeTask(t.id);
          if (this.currentTaskId === t.id) this.currentTaskId = null;
          this.refresh();
        })
    );
    menu.showAtMouseEvent(e);
  }

  private renderBoard() {
    const container = this.contentEl;
    container.empty();
    container.addClass("task-view");

    const toolbar = container.createDiv({ cls: "task-toolbar" });
    const head = toolbar.createDiv({ cls: "task-toolbar-head" });
    head.createEl("h2", { text: "任务看板" });
    const addBtn = toolbar.createEl("button", { text: "＋ 添加任务", cls: "mod-cta" });
    addBtn.addEventListener("click", () => this.openAddModal());
    const listBtn = toolbar.createEl("button", { text: "列表" });
    listBtn.addEventListener("click", () => {
      this.viewMode = "list";
      this.refresh();
    });

    const all = this.plugin.getAll();
    const board = container.createDiv({ cls: "task-board" });
    for (const col of COLUMNS) {
      const colEl = board.createDiv({ cls: "task-col", attr: { "data-status": col.key } });
      const tasks = all.filter((t) => t.status === col.key);
      colEl.createDiv({ cls: "task-col-header", text: `${col.label} (${tasks.length})` });
      const colList = colEl.createDiv({ cls: "task-col-list" });
      for (const t of tasks) {
        this.renderCard(colList, t, true);
      }
      colEl.addEventListener("dragover", (e) => {
        e.preventDefault();
        colEl.addClass("drop-active");
      });
      colEl.addEventListener("dragleave", () => {
        colEl.removeClass("drop-active");
      });
      colEl.addEventListener("drop", (e) => {
        e.preventDefault();
        colEl.removeClass("drop-active");
        const id = this.dragId;
        this.dragId = null;
        if (id) {
          void this.plugin.updateTask(id, { status: col.key });
        }
      });
    }

    container.createDiv({
      cls: "task-hint",
      text: "把卡片拖到其他列即可改变状态（待办 / 进行中 / 完成）。点击卡片进详情。",
    });
  }

  private renderStats() {
    const container = this.contentEl;
    container.empty();
    container.addClass("task-view");

    const toolbar = container.createDiv({ cls: "task-toolbar" });
    const head = toolbar.createDiv({ cls: "task-toolbar-head" });
    head.createEl("h2", { text: "统计" });
    const listBtn = toolbar.createEl("button", { text: "列表" });
    listBtn.addEventListener("click", () => {
      this.viewMode = "list";
      this.refresh();
    });
    const boardBtn = toolbar.createEl("button", { text: "看板" });
    boardBtn.addEventListener("click", () => {
      this.viewMode = "board";
      this.refresh();
    });

    const all = this.plugin.getAll();
    const total = all.length;
    const cnt = (s: Status) => all.filter((t) => t.status === s).length;
    const done = cnt("done");
    const rate = total ? Math.round((done / total) * 100) : 0;

    const kpis = container.createDiv({ cls: "stats-kpis" });
    const kpi = (label: string, val: string) => {
      const c = kpis.createDiv({ cls: "stats-kpi" });
      c.createDiv({ cls: "stats-kpi-label", text: label });
      c.createDiv({ cls: "stats-kpi-val", text: val });
    };
    kpi("总任务", String(total));
    kpi("待办", String(cnt("todo")));
    kpi("进行中", String(cnt("doing")));
    kpi("已完成", String(done));
    kpi("完成率", `${rate}%`);

    const prio = container.createDiv({ cls: "stats-section" });
    prio.createEl("h3", { text: "优先级分布" });
    for (const p of PRIORITY_ORDER) {
      const n = all.filter((t) => t.priority === p).length;
      const row = prio.createDiv({ cls: "stats-bar-row" });
      row.createSpan({ cls: "stats-bar-label", text: PRIORITY_LABEL[p] });
      const track = row.createDiv({ cls: "stats-bar-track" });
      track.createDiv({
        cls: `stats-bar-fill priority-${p}`,
        attr: { style: `width:${total ? (n / total) * 100 : 0}%` },
      });
      row.createSpan({ cls: "stats-bar-val", text: String(n) });
    }

    const src = container.createDiv({ cls: "stats-section" });
    src.createEl("h3", { text: "按来源分布" });
    for (const g of groupTasks(all)) {
      const row = src.createDiv({ cls: "stats-bar-row" });
      row.createSpan({ cls: "stats-bar-label", text: g.label });
      const track = row.createDiv({ cls: "stats-bar-track" });
      track.createDiv({
        cls: `stats-bar-fill pr-guess`,
        attr: { style: `width:${total ? (g.tasks.length / total) * 100 : 0}%` },
      });
      row.createSpan({ cls: "stats-bar-val", text: String(g.tasks.length) });
    }

    const weekly = container.createDiv({ cls: "stats-section" });
    weekly.createEl("h3", { text: "近 8 周完成数" });
    const weeks = buildWeeks(all);
    const max = Math.max(1, ...weeks.map((w) => w.count));
    const wrow = weekly.createDiv({ cls: "stats-weekly" });
    for (const w of weeks) {
      const col = wrow.createDiv({ cls: "stats-week-col" });
      col.createDiv({
        cls: "stats-week-bar",
        attr: { style: `height:${Math.max(3, (w.count / max) * 100)}px` },
      });
      col.createDiv({ cls: "stats-week-label", text: `${w.count}` });
      col.createDiv({ cls: "stats-week-label", text: w.label });
    }
    if (!all.some((t) => t.completedAt)) {
      weekly.createDiv({
        cls: "task-hint",
        text: "把任务标记为「完成」后，这里会记录完成日期并显示每周趋势。",
      });
    }
  }

  private renderDetail(id: string) {
    const container = this.contentEl;
    container.empty();
    container.addClass("task-view");

    const t = this.plugin.getAll().find((x) => x.id === id);
    if (!t) {
      this.currentTaskId = null;
      this.renderList();
      return;
    }

    const top = container.createDiv({ cls: "task-det-top" });
    const back = top.createEl("button", { text: "← 返回" });
    back.addEventListener("click", () => {
      this.currentTaskId = null;
      this.refresh();
    });
    const del = top.createEl("button", { text: "删除" });
    del.addEventListener("click", async () => {
      await this.plugin.removeTask(t.id);
      this.currentTaskId = null;
      this.refresh();
    });
    const edit = top.createEl("button", { text: "编辑", cls: "mod-cta" });
    edit.addEventListener("click", () => {
      new AddTaskModal(this.app, async (r) => {
        await this.plugin.updateTask(t.id, { ...r, recur: (r.recur as Recur) || undefined });
        this.refresh();
      }, t).open();
    });

    container.createEl("h2", { text: t.name });

    const statusText = t.status === "done" ? "✓ 已完成" : STATUS_LABEL[t.status];
    const nextText =
      t.status === "todo"
        ? "→ 转到「进行中」"
        : t.status === "doing"
          ? "→ 标记「完成」"
          : "→ 重置「待办」";
    const statusBtn = container.createEl("button", {
      text: `${statusText} · ${nextText}`,
      cls: t.status === "done" ? "" : "mod-cta",
    });
    statusBtn.addEventListener("click", () => {
      void this.plugin.cycleStatus(t.id);
    });

    const fields = container.createDiv({ cls: "task-detail-fields" });
    fields.createDiv({ cls: "task-detail-field-value", text: `优先级：${PRIORITY_LABEL[t.priority]}` });
    if (t.recur) fields.createDiv({ cls: "task-detail-field-value", text: `重复：${RECUR_LABEL[t.recur]}` });
    fields.createDiv({ cls: "task-detail-field-value", text: `来源：${sourceLabel(t)}` });
    if (t.dueDate) fields.createDiv({ cls: "task-detail-field-value", text: `截止日期：${t.dueDate}` });
    if (t.tags.length) {
      const tags = fields.createDiv({ cls: "task-tags" });
      for (const x of t.tags) tags.createSpan({ cls: "task-tag", text: `#${x}` });
    }

    // 子任务（支持内容 / 优先级 / 截止）
    const subSection = fields.createDiv({ cls: "task-subs" });
    const subHead = subSection.createDiv({ cls: "task-sub-head" });
    subHead.createDiv({ cls: "task-detail-content-label", text: "子任务" });
    const subAddBtn = subHead.createEl("button", { text: "＋ 添加", cls: "mod-cta" });
    subAddBtn.addEventListener("click", () => this.openSubModal(t.id));
    const subList = subSection.createDiv({ cls: "task-sub-list" });
    const subs = t.subtasks ?? [];
    for (const s of subs) {
      const row = subList.createDiv({
        cls: `task-sub priority-${s.priority}${s.done ? " is-done" : ""}`,
      });
      const cb = row.createEl("input", { type: "checkbox", cls: "task-checkbox" });
      cb.checked = s.done;
      cb.addEventListener("click", () => void this.plugin.toggleSubtask(t.id, s.id));
      const body = row.createDiv({ cls: "task-sub-body" });
      body.createDiv({ cls: "task-sub-name", text: s.name });
      if (s.content) body.createDiv({ cls: "task-sub-summary", text: s.content });
      const m = body.createDiv({ cls: "task-card-meta" });
      const mb: string[] = [];
      if (s.dueDate) mb.push(`📅 ${s.dueDate}`);
      if (mb.length) m.setText(mb.join("   "));
      const editBtn = row.createEl("button", { text: "✎", cls: "task-sub-del", title: "编辑" });
      editBtn.addEventListener("click", () => this.openSubModal(t.id, s));
      const del = row.createEl("button", { text: "✕", cls: "task-sub-del", title: "删除" });
      del.addEventListener("click", () => void this.plugin.removeSubtask(t.id, s.id));
    }
    if (!subs.length) subList.createDiv({ cls: "task-sub-empty", text: "暂无子任务" });

    const actions = container.createDiv({ cls: "task-det-actions" });
    if (t.source.kind === "note") {
      const openBtn = actions.createEl("button", { text: "打开所在笔记" });
      openBtn.addEventListener("click", () => this.openSourceNote(t));
    }
    const exportBtn = actions.createEl("button", { text: "导出到当前库笔记" });
    exportBtn.addEventListener("click", () => void this.exportToCurrentVault(t));

    fields.createDiv({ cls: "task-detail-content-label", text: "内容" });
    const contentEl = fields.createDiv({ cls: "task-detail-content" });
    if (t.content) {
      contentEl.setText(t.content);
    } else {
      contentEl.setText("（无内容）");
      contentEl.addClass("is-empty");
    }
  }

  private openSourceNote(t: Task) {
    if (t.source.kind !== "note") return;
    const curName = this.app.vault.getName();
    if (t.source.vault !== curName) {
      new Notice(`该笔记属于「${t.source.vault}」，请打开那个库查看`);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(t.source.notePath);
    if (file instanceof TFile) {
      void this.app.workspace.openLinkText(file.path, "", false);
    } else {
      new Notice("未找到该笔记");
    }
  }

  private async exportToCurrentVault(t: Task) {
    const rel = "任务导出.md";
    const meta: string[] = [];
    if (t.dueDate) meta.push(`📅 ${t.dueDate}`);
    if (t.priority === "urgent") meta.push("🔺");
    else if (t.priority === "high") meta.push("⏫");
    else if (t.priority === "medium") meta.push("🔼");
    else meta.push("🔽");
    meta.push(...t.tags.map((x) => `#${x}`));
    const line = `- [ ] ${t.name}${meta.length ? " " + meta.join(" ") : ""}`;
    let existing = "";
    try {
      existing = await this.app.vault.adapter.read(rel);
    } catch {
      existing = "";
    }
    await this.app.vault.adapter.write(rel, existing.trimEnd() + "\n" + line + "\n");
    new Notice(`已导出到「${rel}」，重载后可看到`);
  }

  private openSubModal(taskId: string, existing?: SubTask) {
    new SubTaskModal(
      this.app,
      async (r) => {
        if (existing) {
          await this.plugin.updateSubtask(taskId, existing.id, r);
        } else {
          await this.plugin.addSubtask(taskId, r);
        }
      },
      existing
    ).open();
  }

  private openAddModal() {
    new AddTaskModal(this.app, async (r) => {
      await this.plugin.addTask(r);
      this.currentTaskId = null;
      this.refresh();
    }).open();
  }
}

export class AddTaskModal extends Modal {
  private onSubmit: (r: NewTaskInput) => void;
  private existing?: Task;

  constructor(app: App, onSubmit: (r: NewTaskInput) => void, existing?: Task) {
    super(app);
    this.onSubmit = onSubmit;
    this.existing = existing;
  }

  onOpen() {
    const t = this.existing;
    const { contentEl } = this;
    contentEl.createEl("h2", { text: t ? "编辑任务" : "新建任务" });

    const name = contentEl.createEl("input", {
      type: "text",
      placeholder: "任务名称 *",
      cls: "task-modal-input",
    });
    name.value = t?.name ?? "";

    contentEl.createDiv({ cls: "task-modal-label", text: "优先级" });
    const sel = contentEl.createEl("select", { cls: "task-modal-select" });
    for (const p of PRIORITY_ORDER) {
      const opt = sel.createEl("option", { text: PRIORITY_LABEL[p], value: p });
      if (t?.priority === p) opt.setAttribute("selected", "true");
    }

    contentEl.createDiv({ cls: "task-modal-label", text: "内容" });
    const content = contentEl.createEl("textarea", {
      placeholder: "任务内容（可选）",
      cls: "task-modal-textarea",
    });
    content.value = t?.content ?? "";

    contentEl.createDiv({ cls: "task-modal-label", text: "截止日期" });
    const due = contentEl.createEl("input", { type: "date", cls: "task-modal-input" });
    due.value = t?.dueDate ?? "";

    contentEl.createDiv({ cls: "task-modal-label", text: "标签（逗号分隔）" });
    const tags = contentEl.createEl("input", {
      type: "text",
      placeholder: "例如：工作, 重要",
      cls: "task-modal-input",
    });
    tags.value = (t?.tags ?? []).join(",");

    contentEl.createDiv({ cls: "task-modal-label", text: "重复" });
    const recurSel = contentEl.createEl("select", { cls: "task-modal-select" });
    recurSel.createEl("option", { text: "不重复", value: "" });
    for (const r of ["daily", "weekly", "monthly"] as Recur[]) {
      const o = recurSel.createEl("option", { text: RECUR_LABEL[r], value: r });
      if (t?.recur === r) o.setAttribute("selected", "true");
    }

    const row = contentEl.createDiv({ cls: "task-modal-button-row" });
    const cancel = row.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const ok = row.createEl("button", { text: t ? "保存" : "添加", cls: "mod-cta" });
    ok.addEventListener("click", () => {
      this.close();
      this.onSubmit({
        name: name.value.trim(),
        priority: sel.value as Priority,
        content: content.value.trim(),
        dueDate: due.value,
        tags: tags.value.split(",").map((s) => s.trim()).filter(Boolean),
        recur: recurSel.value as Recur | "",
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class SubTaskModal extends Modal {
  private onSubmit: (r: {
    name: string;
    content: string;
    priority: Priority;
    dueDate: string;
  }) => void;
  private existing?: SubTask;

  constructor(
    app: App,
    onSubmit: (r: { name: string; content: string; priority: Priority; dueDate: string }) => void,
    existing?: SubTask
  ) {
    super(app);
    this.onSubmit = onSubmit;
    this.existing = existing;
  }

  onOpen() {
    const e = this.existing;
    const { contentEl } = this;
    contentEl.createEl("h2", { text: e ? "编辑子任务" : "新建子任务" });

    const name = contentEl.createEl("input", {
      type: "text",
      placeholder: "子任务名称 *",
      cls: "task-modal-input",
    });
    name.value = e?.name ?? "";

    contentEl.createDiv({ cls: "task-modal-label", text: "优先级" });
    const sel = contentEl.createEl("select", { cls: "task-modal-select" });
    for (const p of PRIORITY_ORDER) {
      const opt = sel.createEl("option", { text: PRIORITY_LABEL[p], value: p });
      if (e?.priority === p) opt.setAttribute("selected", "true");
    }

    contentEl.createDiv({ cls: "task-modal-label", text: "内容" });
    const content = contentEl.createEl("textarea", {
      placeholder: "详情（可选）",
      cls: "task-modal-textarea",
    });
    content.value = e?.content ?? "";

    contentEl.createDiv({ cls: "task-modal-label", text: "截止日期" });
    const due = contentEl.createEl("input", { type: "date", cls: "task-modal-input" });
    due.value = e?.dueDate ?? "";

    const row = contentEl.createDiv({ cls: "task-modal-button-row" });
    const cancel = row.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const ok = row.createEl("button", { text: e ? "保存" : "添加", cls: "mod-cta" });
    ok.addEventListener("click", () => {
      this.close();
      this.onSubmit({
        name: name.value.trim(),
        priority: sel.value as Priority,
        content: content.value.trim(),
        dueDate: due.value,
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
