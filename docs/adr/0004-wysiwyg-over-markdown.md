# 说明页所见即所得，底层存纯 Markdown

状态：已接受（2026-09-19）

「截图加文字说明」是使用频率最高的录入场景，要求粘贴截图、拖拽调整，同时 Agent 要能直接读写正文。因此编辑器界面是所见即所得的块式编辑，磁盘上是纯 `.md`，图片用相对路径引用 `assets/`——Markdown 是落盘格式，不是编辑体验，两者分离。

## Consequences

- Agent 与人能编辑同一份内容：Agent 写 Markdown，人看图操作
- SVN diff 干净且可读
- 编辑器内核必须选 Markdown-first 的实现（如 Milkdown 一类），而不是在 HTML 富文本上做 Markdown 序列化，否则双向映射的边界情况（复杂表格、深层嵌套、HTML 片段）会失控

## Considered Options

- **所见即所得加自有 JSON 落盘**——交互最好做，但 Agent 改起来不直观，且渲染逻辑要写两套
- **纯 Markdown 源码编辑加预览**——工程最小，但要用户手写语法
