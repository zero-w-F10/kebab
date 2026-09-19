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

- page code 存在 `code` 里，分配后锁死；重排序不改号；新 page 取 module 内最大流水 +1。删掉中间某页不会让后面的号补位，而删掉模块内末尾的号之后再新建会拿回那个号
- section number 由渲染时按标题层级算出：`##` → `1`，`###` → `1.1`
- 跨页引用靠锚点：`dist/<page-id>.html#<page-id>-1-2`

**stale write**：编辑器监听 `site.json`、`pages/`、`assets/` 的变化。检测到外部改动即把内存状态标记为 stale 并提示重载；stale 状态下保存被拦截，避免覆盖 Agent 的改动。判定依据是修改时间加内容哈希，不只看时间戳。见 [ADR-0006](adr/0006-stale-write-guard.md)。

**proto 页展示**：iframe 嵌入内容区，附「全屏」按钮。见 [ADR-0003](adr/0003-prototype-iframe-embedding.md)。

**构建产物**：每个 site 产出 `sites/<id>/dist/`——`index.html` 是该原型的概览页（站点标题加 module 列表），其余 `<page-id>.html` 一页一个独立 HTML，导航树烘焙在内，`assets/` 与 `prototypes/` 原样复制。根 `dist/index.html` 是门户页，列出全部 site，链接指向各自的 `dist/index.html`。

**构建范围**：`npm run build` 构建全部 site；`npm run build <site-id>...` 只构建指定的一批。任一 site 失败即中止，门户页不更新；门户页把尚未构建的 site 标出来且不可点。

**导入校验**：原型目录进库前扫描四类问题——`<script type="module">`、`fetch`/`XMLHttpRequest` 读本地资源、公网 CDN 引用、引用了却在原型目录里找不到的本地资源（含以 `/` 开头、在 `file://` 下会指向磁盘根的路径）。判定只取会真正发起请求的位置：HTML 的资源属性、CSS 与 JS 的 `url()`、`@import`；普通文本里的 URL 不算。报告对每类问题附一句处理建议。发现问题即中止构建，`--force` 可强制通过。见 [ADR-0007](adr/0007-prototype-import-check.md)。

## 编辑器

本地服务加浏览器 UI，用来改 `site.json` 与 doc 页正文。

```
npm run edit -- --site <site-id>      # sites/ 下只有一个产品原型时可省掉 --site
```

- 服务端用 Node 内置的 `http`，不引框架，只监听 `127.0.0.1`；默认端口 4173，被占用就往后递推
- 前端是手写的 ES module，由 esbuild 打成一个包（产物在 `src/editor/ui/dist/`，不入 git）。引入打包器是为了下一步换 Markdown-first 内核（[ADR-0004](adr/0004-wysiwyg-over-markdown.md)），不是为了这一轮的界面
- 能改：module 与 page 的增删、标题、顺序。拖拽排序只在同一层内进行——module 之间排 module，module 内排 page；page 不跨 module 搬，因为 `code` 前缀与模块绑定
- `page id` 决定文件位置，分配后不要改；`code` 由编辑器按模块内最大流水分配，同样锁死
- 新建 doc 页会落一个空的 `pages/<id>.md`；新建 proto 页只建目录，原型要自己放进去——放之前 doctor 会报 dangling，编辑器把它标成待放原型
- 保存是手动的（`Ctrl+S` 同效）。保存前跑一次 doctor：`duplicate` 拦下，dangling 与 orphan 只提示
- orphan file 的两个出口都在编辑器里：**导入为页面**（只往清单加一条，文件原地不动）、**删除文件**
- 陈旧写入：内存状态持有指纹——`site.json` 内容加 `pages/`、`assets/` 下每个文件的内容哈希。保存时把指纹带上，服务端比对不符即拒绝（409），前端提示重载；另有每两秒一次的轮询，发现外部改动就把状态标成陈旧并拦下保存。见 [ADR-0006](adr/0006-stale-write-guard.md)
- doc 正文是块式所见即所得（Milkdown 的 Crepe，见 [ADR-0004](adr/0004-wysiwyg-over-markdown.md)）。磁盘上仍是纯 Markdown：打开 demo 的正文再序列化回来一字不差，SVN diff 不会凭空多出改动
- 图片走 `assets/`：粘贴或拖进正文的截图自动落盘，正文里写 `assets/<文件名>`（相对站点根，与产物路径一致）。重名自动加序号，只收 png/jpg/jpeg/gif/webp/svg，单张上限 20MB。保存时还有一道兜底：正文里若仍留着内联 base64 图片（编辑器某条路径没走上传），落盘前一样搬进 `assets/` 并改掉路径 —— 正文里永远不出现 base64

## 范围边界

以下内容明确不在 kebab 范围内，免得以后被当成遗漏：

- 图上标注：在截图上画红框、箭头、编号
- 搜索
- 原型页内部链接与导航树同步
- 原型目录压缩：体积由用户自行处理，工具不介入
