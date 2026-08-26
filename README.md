# 任务管理 · Obsidian 插件

一个**跨知识库的本地任务中心**。在**任意一个** Obsidian 知识库打开它，都能看到整个知识目录下**所有库**的任务，并按来源(哪个库/哪篇笔记)分组——把散落在各处的待办汇聚成一个总面板。

> （界面截图待补充：`docs/screenshot-list.png` / `docs/screenshot-board.png`）

## 功能

- **跨库总览** — 以你设置的"知识库根目录"为单位检索；每项带来源标签(🧑 个人 / 📚 某库 / 📚 某库·某笔记)
- **按来源分组** — 列表按 个人 / 各库 分组，组头可折叠
- **优先级** — 紧急 / 高 / 中 / 低 四档，按优先级排序
- **看板视图** — 待办 / 进行中 / 完成 三列，**拖拽**改变状态
- **统计** — 完成率、优先级分布、按来源分布、近 8 周完成数(横条/柱状)
- **子任务** — 每个任务可挂有内容的子任务清单(名称/内容/优先级/截止)，显示 `☑ 进度`
- **周期提醒** — 任务可设 每天/每周/每月 自动续期；到期高亮、逾期标红，打开时提示
- **右键菜单** — 右键卡片：标记完成 / 编辑 / 打开所在笔记 / 删除
- **笔记待办双向** — 扫描各库笔记里的 `- [ ]` 待办进总览；也可把任务导出成笔记(md)

## 安装(从源码)

```bash
npm install          # 安装构建依赖
npm run build        # 产出 dist/main.js
npm run deploy       # (可选)复制到本机各 vault 的 .obsidian/plugins/task-manager
```

手动装进 Obsidian：把 `dist/main.js`、`styles.css`、`manifest.json` 放到
`<你的vault>/.obsidian/plugins/task-manager/`，然后在 Obsidian 设置 → 第三方插件 → 启用。

> 插件为 **desktop-only**：为了跨库读写文件系统，`isDesktopOnly: true`，移动端不可用。

## 使用

1. 在 Obsidian 设置 → 本插件设置里填「知识库根目录」(例如 `D:\WenJian\knowledge`)；留空则只检索当前 vauilt(单库模式)。
2. 点击左侧 ribbon 的 ✅ 图标(或命令"打开任务管理")打开「任务管理」标签页。
3. 顶部在 **列表 / 看板 / 统计** 之间切换。

## 技术栈

- **TypeScript** + **Obsidian Plugin API**(`ItemView` / `Modal` / `Menu` / `vault.adapter`)
- **esbuild** 打包为单文件 `main.js`，**零第三方运行时依赖**
- 原生 DOM(`createEl`/`createDiv`)渲染，深浅色自适应(Obsidian CSS 变量)

## 数据存储

- 中心文件：`<知识库根>/任务/tasks.json`(所有库共用，改动即时全局生效)
- 各库插件 `data.json` 既有任务 + 各库笔记里的 `- [ ]` 待办，启动时扫描并入

## License & 致谢

- MIT License
- 架构参考 [daylee](https://github.com/soltankara/daylee)、优先级/JSON 存储参考 [bun-do](https://github.com/ricardofrantz/bun-do)、任务渲染参考 [obsidian-tasks](https://github.com/obsidian-tasks-group/obsidian-tasks)
