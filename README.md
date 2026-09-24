# Kebab

把 AI 导出的 HTML 原型、界面截图说明、流程图串成一个带导航树的静态站点，供研发同事本地浏览。

项目名取「烤串」之意：一枚签子串起一个 module，签上每一块是一个 page。术语见 [CONTEXT.md](CONTEXT.md)。

## 两种用法，先分清

**只是要看原型**：不需要这个仓库。拿到 `sites/<id>/dist/` 那一个目录就够了——产物零运行时依赖，双击 `index.html` 就能看，不需要 Node、不需要源码、不需要服务器（见 [ADR-0001](docs/adr/0001-file-protocol-compatible-output.md)）。

**要用它做站点**：需要 Node，往下看。

## 环境

- Node **22 或更高**（开发与验证全程在 v24.18.0 上）
- 装依赖**别加 `--omit=dev`**：编辑器前端的打包器 esbuild 在 `devDependencies` 里，省掉它 `npm run edit` 第一步就会失败

```bash
npm install
```

## 上手三步

**1. 建一个站点。** `sites/` 不在这个仓库里（那是使用者的内容，走 SVN 不走 git），所以克隆出来是空的。照 [docs/authoring.md](docs/authoring.md) 的「新增产品原型」建 `sites/<id>/`，至少要有 `site.json`。

**2. 进编辑器改内容。**

```bash
npm run edit -- --site <id>      # sites/ 下只有一个站点时可以省掉 --site
```

终端会打印地址（默认 `http://127.0.0.1:4173/`），浏览器打开它。左侧是导航树，右侧改 doc 正文或预览原型。

**3. 出产物。** 编辑器顶部工具栏有「构建」，或者命令行：

```bash
npm run build -- <id>...         # 不写 id 就构建全部
```

产物在 `sites/<id>/dist/`，拷走这一份就能发人。

## 命令

| 命令 | 做什么 |
|---|---|
| `npm run doctor` | 核对全部站点：清单与磁盘是否一致（悬空引用、孤儿文件、闲置素材、重复 id） |
| `npm run build [-- <id>...]` | 构建指定站点（不写则全部）与根门户页 `dist/index.html` |
| `npm run edit -- --site <id>` | 起本地编辑器，默认 `http://127.0.0.1:4173`，端口被占就往后递推 |
| `npm test` | 跑回归测试（doctor 规则、导入校验、编辑器数据层、服务端接口、doc 编辑器、编辑器交互） |

## 目录

```
src/               构建器与编辑器 —— 工具代码，走 git
  build.js           构建：清单 → sites/<id>/dist/
  doctor.js          一致性核对（构建与编辑器共用同一套规则）
  layout.js          产物 HTML 的骨架、导航树与收起开关
  render.js          doc 正文渲染：Markdown → HTML，算条目编号与锚点、图片放大
  import-check.js    原型目录进库前的可运行性核对
  editor/            本地编辑器：server.js + store.js + ui/
  style.css          产物样式（构建时复制成每个 dist 的 kebab.css）
  icon.svg           产物图标（矢量）
  icon.png           产物图标（位图，由 tools/render-icon-png.ps1 生成）
sites/             使用者的内容与生成物，不在 git 里，走 SVN
dist/              根门户页，生成物
tools/             辅助脚本
test/              回归测试
```

## 文档

- [CONTEXT.md](CONTEXT.md) —— 领域术语表。讨论用词、改设计之前先看它
- [docs/design.md](docs/design.md) —— 设计规格：硬约束、目录布局、数据模型、行为规则
- [docs/authoring.md](docs/authoring.md) —— 操作手册：建站点、加页面、构建、排错、交付
- [docs/adr/](docs/adr/) —— 架构决策记录，每条决定的来由
- [AGENTS.md](AGENTS.md) —— 文档地图与工作区约定（主要写给 AI agent）
