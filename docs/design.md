# kebab 设计规格

本文件记录 kebab 的形态与规则。术语见 [CONTEXT.md](../CONTEXT.md)，每条规则的来由见 [docs/adr/](adr/)。

## 硬约束：产物必须 file:// 可运行

同事双击 `dist/index.html` 打开，中间没有服务器。由此推出：

- 构建产物零运行时 JS 依赖，导航树在构建时烘焙进每一个 HTML 文件
- 不用 ES module，不用 fetch 读本地数据
- 不出现任何指向公网的资源（字体、CDN 一律本地）

该约束同样作用于导入的内容：原型目录里若含 module 脚本、本地 fetch 或外链，导入时拦下，见 [ADR-0007](adr/0007-prototype-import-check.md)。

## 目录布局

一个工作区承载多个 site，每个 site 是一个产品原型：自己的导航树、正文、素材、产物，互不引用。`sites/` 下的目录名就是 site id，见 [ADR-0008](adr/0008-multiple-sites-per-workspace.md)。

```
kebab/                        # 工具代码仓库（git）
  sites/                      # 使用者的内容与生成物，不在 git 里，复制出去走 SVN
    <site-id>/
      site.json               # 它的导航树的唯一真相
      pages/                  # 它的 doc 页正文
      assets/                 # 它的图片
      prototypes/             # 它的 proto 页原型目录
      dist/                   # 它的交付物，拷走这一份就能发人
  dist/                       # 根门户页，同样是生成物，不在 git 里
  src/                        # 构建器，所有 site 共用
  node_modules/
  CONTEXT.md AGENTS.md docs/  # 文档
```

## 版本控制

**工具代码走 git**：这个仓库只有构建器与设计文档——`src/`、`docs/`、`CONTEXT.md`、`AGENTS.md`、`package.json`、`package-lock.json`。`sites/`、`dist/`、`node_modules/`、`.reasonix/`、`.agents/` 在 `.gitignore` 里。

**内容与交付物走 SVN**：`sites/` 下的编辑内容和生成物不属于这个仓库，由使用者复制到 SVN 工作副本管理。因此克隆本仓库只得到构建器，`npm run build` 会提示 `sites/` 下没有任何产品原型——这是预期行为，不是故障。

## 数据模型

`site.json` 是导航树的唯一真相。内容位置由 page 的 id 推出，刻意不写成字段——磁盘布局本身就是真相，写成字段只会多出一处可以互相矛盾的状态。

```jsonc
{
  "site": {
    "title": "XX 产品原型",
    "subtitle": "V2.3 评审稿"            // 可选
  },
  "modules": [
    {
      "id": "login",
      "title": "登录与注册",
      "prefix": "LO",                    // page code 的前缀，分配后锁死
      "pages": [
        { "id": "login-revamp", "code": "LO-01", "type": "doc",   "title": "登录页改版说明" },
        { "id": "login-flow",   "code": "LO-02", "type": "doc",   "title": "登录流程图" },
        { "id": "login-v2",     "code": "LO-03", "type": "proto", "title": "新版登录页原型" }
      ]
    }
  ]
}
```

约定：

- doc 页正文 = `pages/<id>.md`
- proto 页原型目录 = `prototypes/<id>/`，入口 = `index.html`（可用 `entry` 字段覆盖）
- doc 页图片 = `assets/`；正文里按站点根书写（`assets/x.svg`，不是 `../assets/x.svg`），源与产物的路径因此完全一致

导航树只有两层：module → page。嵌套 module 暂不支持。

## 行为规则

**doctor** 对每个 site 独立跑，在编辑器启动时和每次保存前执行：

- dangling reference：清单里有 page，`pages/` 或 `prototypes/` 里找不到
- orphan file：磁盘上有文件，清单里没有任何 page 引用它（给「导入为页面」和「删除」两个出口）
- 重复：`id` 或 `code` 在清单里出现两次，直接拦住保存

**编号**

- page code 存在 `code` 里，分配后锁死；重排序不改号，删 page 不复用号，新 page 取 module 内最大流水 +1
- section number 由渲染时按标题层级算出：`##` → `1`，`###` → `1.1`
- 跨页引用靠锚点：`dist/<page-id>.html#<page-id>-1-2`

**stale write**：编辑器监听 `site.json`、`pages/`、`assets/` 的变化。检测到外部改动即把内存状态标记为 stale 并提示重载；stale 状态下保存被拦截，避免覆盖 Agent 的改动。判定依据是修改时间加内容哈希，不只看时间戳。见 [ADR-0006](adr/0006-stale-write-guard.md)。

**proto 页展示**：iframe 嵌入内容区，附「全屏」按钮。见 [ADR-0003](adr/0003-prototype-iframe-embedding.md)。

**构建产物**：每个 site 产出 `sites/<id>/dist/`——`index.html` 是该原型的概览页（站点标题加 module 列表），其余 `<page-id>.html` 一页一个独立 HTML，导航树烘焙在内，`assets/` 与 `prototypes/` 原样复制。根 `dist/index.html` 是门户页，列出全部 site，链接指向各自的 `dist/index.html`。

**构建范围**：`npm run build` 构建全部 site；`npm run build <site-id>...` 只构建指定的一批。任一 site 失败即中止，门户页不更新；门户页把尚未构建的 site 标出来且不可点。

**导入校验**：原型目录进库前扫描三类问题——`<script type="module">`、`fetch`/`XMLHttpRequest` 读本地资源、公网 CDN 引用。发现问题即中止构建，`--force` 可强制通过。见 [ADR-0007](adr/0007-prototype-import-check.md)。

尚未实现的欠账：ADR-0007 还要求检测「原型内部引用却不存在的资源」，以及给出处理建议，两者都还没做。

## 范围边界

以下内容明确不在 kebab 范围内，免得以后被当成遗漏：

- 图上标注：在截图上画红框、箭头、编号
- 搜索
- 原型页内部链接与导航树同步
- 原型目录压缩：体积由用户自行处理，工具不介入
