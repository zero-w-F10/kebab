# 用 site.json 中心清单加外置正文文件

状态：已接受（2026-09-19）

导航树要支持拖拽排序，内容又要同时能被浏览器编辑器、人和 Agent 改写，还要保证 SVN diff 干净。因此让 `site.json` 持有模块、页面顺序、标题、类型和编号，正文外置为 `pages/<id>.md` 与 `prototypes/<id>/`，靠 page 的 id 关联——正文位置由 id 推出，不写成字段。

## Consequences

- 拖拽排序、改标题都只改一个文件，diff 干净且可读
- 清单和磁盘会失配，产生 dangling reference、orphan file 和重复 id，必须靠 doctor 兜住

## Considered Options

- **一页一文件夹自包含**（`content/<slug>/page.json` 加 `body.md`）——删页等于删文件夹是优点，但排序要扫遍整个目录，导航标题散落各处，拖拽重排要在多个文件间搬东西
- **单一 `site.json` 内嵌正文**——文件随内容膨胀，多 Agent 并行改动时冲突面极大
