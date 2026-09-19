# 往 kebab 里加内容

一个产品原型从零到能交付要走的步骤，以及每一步的完成标准。术语见 [CONTEXT.md](../CONTEXT.md)，规则的来由见 [design.md](design.md) 与 [docs/adr/](adr/)。

## 新增一个产品原型

### 1. 建目录

`sites/<site-id>/`。site id 会成为门户页里的标识，用短横线小写英文。

### 2. 写 site.json

```jsonc
{
  "site": { "title": "显示名", "subtitle": "副标题，可选" },
  "modules": [
    {
      "id": "mod-id",
      "title": "模块名",
      "prefix": "CO",                                  // page code 的前缀，分配后锁死
      "pages": [
        { "id": "page-id", "code": "CO-01", "type": "proto", "title": "页面标题" }
      ]
    }
  ]
}
```

- `page.id` 同时决定文件位置：proto 页找 `prototypes/<id>/`，doc 页找 `pages/<id>.md`，产物是 `dist/<id>.html`
- `code` 是给人看的展示编号，分配后不要再改
- 树只有两层：module → page

### 3. 放内容

proto 页见下一节，doc 页见下下节。

### 4. 核对

```
npm run doctor
```

**完成标准**：每个 site 都输出 `✓`。`dangling`（清单有、磁盘没有）、`orphan`（磁盘有、清单没有）、`duplicate`（id 或 code 重复）都必须先解决，否则下一步会被拦住。

### 5. 构建

```
npm run build                # 全部 site
npm run build -- <site-id>   # 只构建指定的，可给多个
```

产出 `sites/<id>/dist/`（自包含）和根 `dist/index.html`（门户页）。

### 6. 验证

双击 `sites/<id>/dist/index.html`，逐项确认：

- 地址栏是 `file://`，不是 `http://`
- 左侧导航列出全部页面，且当前页高亮
- proto 页的 iframe 里有内容，不是空白
- doc 页的图片正常显示

## 加一个 proto 页（AI 导出的页面）

1. 把 AI 导出的**整个目录**放进 `prototypes/<page-id>/`。缺了这一层 page id 目录是最常见的错误。
2. 一个字节都不要改它。
3. 入口默认是 `index.html`；文件名不是这个，就在该 page 里加 `"entry": "实际文件名.html"`。

**导入校验**在构建时拦下四类会让同事白屏的写法：

| 问题 | 为什么 |
|---|---|
| `<script type="module">` | `file://` 下被浏览器按 CORS 规则拦掉 |
| `fetch()` / `XMLHttpRequest` | `file://` 下读不到资源 |
| HTML 的资源属性、CSS 的 `url()` / `@import` 指向公网 | 同事内网离线时加载不到 |
| 同上这些位置引用的本地资源不可用 | 文件没拷全，或路径以 `/` 开头——`file://` 下 `/` 会解析到磁盘根 |

被拦时报告会给每类问题配一句怎么办，出口有三个：

- **首选**：让 AI 重新导出成自包含的单文件版本
- **文件没拷全**：把缺的补进 `prototypes/<page-id>/` 的对应位置
- **确认无碍**：`npm run build -- --force`

`<a href>` 指向公网不算问题，那是点击后才走的链接，不会白屏；JS 里的文档链接和 XML 命名空间也不算，它们只是字符串。校验只报真正会发起请求的位置，所以不存在的本地页面链接（`<a href="xxx.html">`）也不查。

## 加一个 doc 页（截图 + 文字说明）

1. 正文写到 `pages/<page-id>.md`（`pages/` 目录不存在就建）
2. 图片放进 `assets/`
3. 正文里按**站点根**引用图片：写 `assets/shot-1.png`，不是 `../assets/shot-1.png`。源文件和构建产物因此路径一致，不需要重写

写法约定：

- **正文从 `##` 开始**。`#` 留给页面标题，那个你在 `site.json` 里已经写了
- 标题层级会变成条目编号：`##` → `1`，`###` → `1.1`。渲染时自动算，**不要手写编号**
- 每个标题会拿到锚点 `<page-id>-1-2`，可跨页引用：`dist/<page-id>.html#<page-id>-1-2`
- 条目必须是有标题的块。散落的列表项不参与编号，也无法被锚定

## 用编辑器改内容

导航树和 doc 正文都能在浏览器里改，比手写 `site.json` 稳——编号分配、一致性和陈旧写入都由它兜住。

```
npm run edit -- --site <site-id>      # sites/ 下只有一个产品原型时可以省掉 --site
```

终端会打印一个 `http://127.0.0.1:4173/`，打开它。能做的事：

- 新增/删除模块与页面，拖拽排序，改标题
- 点开 doc 页改正文源码；proto 页在右侧 iframe 里预览，另有「全屏打开」
- 底部核对栏列出悬空引用、孤儿文件、重复编号。孤儿文件就地给两个出口：**导入为页面**（只改清单，文件原地不动）与**删除文件**

几条约定：

- **保存是手动的**，`Ctrl+S` 同效。保存前会跑一次 doctor，`code` 或 `id` 重复会被直接拦下
- `code` 与 `page id` 分配后不要改。前者是给研发对齐的引用，后者决定文件位置
- 新增 proto 页只建目录，把 AI 导出的原型整个放进去，再回编辑器保存
- Agent 在后台改了文件时，编辑器会把状态标成「陈旧」并拦住保存。点「重载」拿到最新内容再继续——这是有意为之，避免覆盖别人的改动

## 常见报错

| 报错 | 原因 | 怎么办 |
|---|---|---|
| `找不到 pages/<id>.md` | 清单里有这个 doc 页，文件没建 | 建文件，或从 `site.json` 删掉这条 |
| `找不到原型入口 prototypes/<id>/index.html` | proto 页缺 page id 那一层目录，或入口文件名不对 | 内容放进 `prototypes/<id>/`；入口不是 `index.html` 就写 `entry` |
| `孤儿文件：pages/xxx.md` | 文件建了，清单里没有 | 在 `site.json` 加一条，或删掉文件 |
| `孤儿文件：prototypes/xxx` | 同上 | 同上 |
| `id 重复` / `code 重复` | 两处用了同一个标识 | 改掉其中一个。`code` 分配后本不该变 |
| `引用了 N 个原型目录里没有的文件` | 原型导出时就没带上这些文件，拷贝时又漏了 | 把缺的文件补进 `prototypes/<page-id>/` 的对应位置；补不齐就让 AI 重新导出 |
| `以 / 开头引用本地资源` | 路径写成了站点绝对路径 | 改成相对路径，如 `./assets/logo.png` |
| `sites/ 下没有任何产品原型` | 这个仓库只有工具代码，`sites/` 是你的内容，不在 git 里 | 正常，不是故障。放内容进去即可 |
| `指定的产品原型不存在` | `npm run build -- xxx` 的 xxx 写错了 | 报错信息里会列出可用的 id |

## 交付

`sites/<id>/dist/` **完全自包含**：拷走、压缩、丢到任意位置，同事双击 `index.html` 就能看，不需要工具、不需要源码、不需要其他目录。

**不要单独拿走根目录的 `dist/`**。它是门户页，链接写成 `../sites/<id>/dist/index.html`，出了仓库结构就是一堆死链。

构建会删掉并重建 `dist/`，所以要传给 SVN 时，提交前先看一眼哪些是新增（`?`）、哪些已消失（`!`）。
