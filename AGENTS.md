# kebab

原型交付站点生成器：把 AI 导出的 HTML 原型、界面截图说明、流程图合成一个带导航树的静态站点，整目录传 SVN 供本地浏览。

## 文档地图

- [`CONTEXT.md`](CONTEXT.md) — 领域术语表。写代码、改设计规格或讨论取舍之前，先读它对齐用词。
- [`docs/design.md`](docs/design.md) — 设计规格：硬约束、目录布局、数据模型、行为规则。实现任何功能前先读它。
- [`docs/adr/`](docs/adr/) — 架构决策记录。改动被某条 ADR 覆盖的设计前，先读那条 ADR，否则会推翻一个有意为之的决定。

## 环境

这个工作区是 kebab **工具代码**的 git 仓库。`sites/`（使用者的编辑内容与生成物）、`dist/`、`node_modules/`、`.reasonix/`、`.agents/` 都在 `.gitignore` 里——它们是使用者自己的数据或工具运行时产物，不要纳入版本控制。

## 状态

构建管线支持多个产品原型：`npm run doctor` 核对全部，`npm run build [site-id...]` 产出各自的 `sites/<id>/dist/` 与根门户页。编辑器（本地服务加浏览器 UI）尚未实现。

`dist/` 是生成物，手改会在下一次构建被覆盖。
