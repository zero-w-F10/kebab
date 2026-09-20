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
      "pages": [
        { "id": "login-revamp", "type": "doc",   "title": "登录页改版说明",
          "children": [                                  // 可选：这页的下级
            { "id": "login-revamp-a1", "type": "doc", "title": "补充说明" }
          ] },
        { "id": "login-v2",     "type": "proto", "title": "新版登录页原型" }
      ]
    }
  ]
}
```

约定：

- doc 页正文 = `pages/<id>.md`
- proto 页原型目录 = `prototypes/<id>/`，入口 = `index.html`（可用 `entry` 字段覆盖）
- `id`（module 与 page 都一样）只收小写英文、数字与短横线，且以字母或数字开头 —— 它会进文件名，也会进跨页锚点 `#<page-id>-1-2`
- `id` 是 page 唯一的身份，标题只是给人看的（可以重复）。曾经还有一个展示用的 `code`（`LO-01`）和模块上的 `prefix`，已退役，见 [ADR-0010](adr/0010-pages-have-no-code.md)
- doc 页图片 = `assets/`；正文里按站点根书写（`assets/x.svg`，不是 `../assets/x.svg`），源与产物的路径因此完全一致

数组顺序就是导航顺序，没有别的字段表达顺序 —— 想调顺序就调数组。

**页面可以再挂下级**：`children` 是同一个形状的递归（`pages` 之于 module，`children` 之于 page），所以下级的下级一样成立，层数不限。没有 `children` 或不写就是叶子。

- 层级只影响导航树的形状：正文位置一律由 `page id` 推出（`pages/<id>.md`、`prototypes/<id>/`），跟挂在谁下面没有关系。**换父级、改层级，磁盘上一个文件都不搬**，纯粹是清单的改动
- 删一页连带它的整棵子树：留着下级会变成没有父级的悬空节点。见 [ADR-0011](adr/0011-pages-nest.md)
- module 仍然是一级分组、不能嵌套；下级只发生在 page 之间

## 行为规则

**doctor** 对每个 site 独立跑，在编辑器启动时和每次保存前执行：

- dangling reference：清单里有 page，`pages/` 或 `prototypes/` 里找不到
- orphan file：磁盘上有文件，清单里没有任何 page 引用它（给「收编为页面」和「删除」两个出口）
- unused asset：`assets/` 下有文件，但没有任何 doc 页正文引用它 —— 在编辑器里删掉图之后留下的那些（给「删除文件」一个出口）
- 重复：同一个 `id` 在清单里出现两次，直接拦住保存

**编号**

- page 没有编号。顺序由清单里的数组位置表达，拖拽改的就是它；标题是人的把手，`id` 是机器把手
- section number 由渲染时按标题层级算出：`##` → `1`，`###` → `1.1`，见 [ADR-0005](adr/0005-numbering-scheme.md)
- 跨页引用靠锚点：`dist/<page-id>.html#<page-id>-1-2`

**stale write**：编辑器监听 `site.json`、`pages/`、`assets/` 的变化。检测到外部改动即把内存状态标记为 stale 并提示重载；stale 状态下保存被拦截，避免覆盖 Agent 的改动。判定依据是修改时间加内容哈希，不只看时间戳。见 [ADR-0006](adr/0006-stale-write-guard.md)。

**proto 页展示**：iframe 嵌入内容区，附「全屏」按钮。见 [ADR-0003](adr/0003-prototype-iframe-embedding.md)。

**构建产物**：每个 site 产出 `sites/<id>/dist/`——`index.html` 是该原型的概览页（站点标题加 module 列表），其余 `<page-id>.html` 一页一个独立 HTML，导航树烘焙在内，`assets/` 与 `prototypes/` 原样复制；另有 `kebab.css` 与图标 `kebab.svg` + `kebab.png`（构建时从 `src/` 复制，head 里两条 link 都挂上，仍是本地文件）。图标给两份是因为 Chromium 系浏览器不一定肯拿 SVG 当 favicon（Edge 会退回默认的地球图标），矢量与位图是同一图形的两种编码，改图形要一起改，位图由 `tools/render-icon-png.ps1` 光栅化。根 `dist/index.html` 是门户页，列出全部 site，链接指向各自的 `dist/index.html`，同样带这份图标。

**构建范围**：`npm run build` 构建全部 site；`npm run build <site-id>...` 只构建指定的一批。任一 site 失败即中止，门户页不更新；门户页把尚未构建的 site 标出来且不可点。

**doc 正文渲染**：markdown-it 渲染，section number 与跨页锚点在渲染时算，见 [ADR-0005](adr/0005-numbering-scheme.md)。围栏代码渲染成一张卡片——等宽、可横向滚动；语言认得出来的（json、js/ts、sql、yaml、shell）在**构建期**着色，产物里没有一行运行时脚本（硬约束见上）。着色器在 `src/highlight.js`：先切字符串与注释，再认关键字、字面量与数字，认不出来原样吐出——顶多颜色少一点，不改代码一个字符。右上角的语言牌子只给「认得出的语言」与 `mermaid`；`text` 不挂牌子且折行（里面通常是人话），不写语言的也不挂牌子且保留空白（ASCII 草图靠它）。

**构建拦阻**：只有会让产物出错的才拦住构建 —— dangling reference 与重复 id。orphan file 与 unused asset 只作为提示跟着构建结果回来（终端里打印，编辑器弹层里列出），产物照出、门户页照更新。

**导入校验**：原型目录进库前扫描四类问题——`<script type="module">`、`fetch`/`XMLHttpRequest` 读本地资源、公网 CDN 引用、引用了却在原型目录里找不到的本地资源（含以 `/` 开头、在 `file://` 下会指向磁盘根的路径）。判定只取会真正发起请求的位置：HTML 的资源属性、CSS 与 JS 的 `url()`、`@import`；普通文本里的 URL 不算。报告对每类问题附一句处理建议。发现问题即中止构建，`--force` 可强制通过。见 [ADR-0007](adr/0007-prototype-import-check.md)。

## 编辑器

本地服务加浏览器 UI，用来改 `site.json` 与 doc 页正文。

```
npm run edit -- --site <site-id>      # sites/ 下只有一个产品原型时可省掉 --site
```

- 服务端用 Node 内置的 `http`，不引框架，只监听 `127.0.0.1`；默认端口 4173，被占用就往后递推
- 前端是手写的 ES module，由 esbuild 打成一个包（产物在 `src/editor/ui/dist/`，不入 git）。引入打包器是为了下一步换 Markdown-first 内核（[ADR-0004](adr/0004-wysiwyg-over-markdown.md)），不是为了这一轮的界面
- 界面照 axhub make 那一路工具的习惯排：一条顶部工具栏 + 左边导航树 + 右边内容区。工作区级的动作（新建模块、核对、构建、重载、保存）全在顶部工具栏，站点标题与副标题也在那儿
- 浏览器标签页的标题是「站点标题 - Kebab 编辑器」（服务端就替换好，前端在站点标题被改后跟着变）。图标由服务的 `/icon.svg` 与 `/icon.png` 提供，取的是工具自带的 `src/icon.svg`、`src/icon.png`
- 能改：module 与 page 的增删、标题、顺序、层级。标题平时是只读文字，**双击就地改**（Enter 提交、Esc 放弃）；每个 module 与 page 行尾的「⋯」弹出该节点的操作菜单——新建页面（页面上是「新建下级页面」）、重命名、删除。拖动靠行首的「⠿」握把：只有握把是拖拽起点（整行可拖会跟双击改名、正文选择抢鼠标），整行是落点
- 落点按行高分段决定结果，**page 行分三段**：上三分之一 = 跟它同级、插在它前面，中间三分之一 = 变成它的下级（排在已有下级的末尾），下三分之一 = 跟它同级、插在它后面。**module 行只分前后两段**（module 之间没有上下级）；拖到 module 的空白处是固定落点，整块描一圈，表示放进那个 module 的根级末尾 —— 空 module 没有行可落、以及把下级拖回顶层，都靠这一条。落回原位是空操作，不画标记也不标脏。拖一页就是搬它整棵子树；不能被拖进自己的后代里。层级、跨 module 都只改清单，正文文件不动
- 下一级页面在导航树里缩进显示（每级多 14px），一直摊开、不做折叠——折叠状态是界面状态，存进 `site.json` 就多一处会互相矛盾的东西
- 删除是连带的：删一页连同它的整棵子树（确认框里写明下级条数），勾了「同时删掉文件」才动磁盘，不勾则文件留下、变成孤儿文件，可以从核对面板导回来
- `page id` 决定文件位置，分配后不要改；页面的展示编号已经退役，见 [ADR-0010](adr/0010-pages-have-no-code.md)
- 新建 doc 页会落一个空的 `pages/<id>.md`；新建 proto 页只建目录，原型要自己放进去——放之前 doctor 会报 dangling，编辑器把它标成待放原型
- 保存是手动的（`Ctrl+S` 同效）。保存前跑一次 doctor：`duplicate` 拦下，dangling 与 orphan 只提示
- 核对结果不再常驻底栏：顶部「核对」图标带问题条数角标，点开是问题清单。轮询发现磁盘被外部改动时核对结果跟着刷新——往 `pages/` 里丢一个 md，角标与提示立刻跟上，不用先手动重载
- orphan file 的出口在它那一行的「⋯」里：**收编为页面**（只往清单加一条，正文文件原地不动）与**删除文件**。`pages/` 下的孤儿 md 另有批量出口：核对面板里的「全部收编」一次把它们收编成 doc 页
- 收编与删除都是写操作，得先跟磁盘对上指纹：状态陈旧而没有本地改动时（往 `pages/` 里丢文件本身就是这种情况）自己重载一次再动手，免得「一键收编」永远差一次手动重载；有没保存的改动则先请他重载，见 [ADR-0006](adr/0006-stale-write-guard.md)
- 收编时页面标题默认取正文第一条标题；正文顶格的 `#` 是这一页自己的标题，收编后从正文里抹掉（留着会跟页头的大标题重复）。文件名当不了 page id（中文、带点、大小写不对、不叫 `<id>.md`）时把文件改名成 `pages/<id>.md`——正文位置写死由 id 推出，文件名只能跟着它走；这是收编唯一会动使用者文件的地方，改哪些名、id 与标题各是什么，都先在弹层里列出来给人看过
- 顶部工具栏的「构建」构建当前站点，走的是与 `npm run build` 同一条代码路径：结果里列出问题与处理建议，并给一个产物预览入口（`/build/` 路由直接读 `sites/<id>/dist/`）。构建前若还有没保存的改动，先问一句要不要保存
- 保存只写用户真正改动的地方：图片 alt 保留、列表符号保持 `-`、文件以一个换行结尾。为此关掉了 Crepe 的图片块特征 —— 它会把 `![说明](…)` 的 alt 换成 `![1.00](…)`，还在图片前后塞 `<br />`
- 编辑器里的空段落在 Markdown 里表达不出来，Crepe 序列化时会留下孤零零一行 `<br />`；渲染器开着 `html: false`，那行到产物里会显示成字面的「<br />」四个字。落盘前抹掉这类孤立行（回执里报 `stripped` 条数，前端据此刷新正文），行内的 `<br>` 是使用者自己写的换行，不动
- 陈旧写入：内存状态持有指纹——`site.json` 内容加 `pages/`、`assets/` 下每个文件的内容哈希。保存时把指纹带上，服务端比对不符即拒绝（409），前端提示重载；另有每两秒一次的轮询，发现外部改动就把状态标成陈旧并拦下保存。见 [ADR-0006](adr/0006-stale-write-guard.md)
- doc 正文是块式所见即所得（Milkdown 的 Crepe，见 [ADR-0004](adr/0004-wysiwyg-over-markdown.md)）。磁盘上仍是纯 Markdown：打开 demo 的正文再序列化回来一字不差，SVN diff 不会凭空多出改动
- 图片走 `assets/`：粘贴或拖进正文的截图自动落盘，正文里写 `assets/<文件名>`（相对站点根，与产物路径一致）。重名自动加序号，只收 png/jpg/jpeg/gif/webp/svg，单张上限 20MB。保存时还有一道兜底：正文里若仍留着内联 base64 图片（编辑器某条路径没走上传），落盘前一样搬进 `assets/` 并改掉路径 —— 正文里永远不出现 base64

## 范围边界

以下内容明确不在 kebab 范围内，免得以后被当成遗漏：

- 图上标注：在截图上画红框、箭头、编号
- 流程图渲染：`mermaid` 围栏只按纯文本显示（出图要跑运行时脚本，越了上面的硬约束）
- 搜索
- 原型页内部链接与导航树同步
- 原型目录压缩：体积由用户自行处理，工具不介入
