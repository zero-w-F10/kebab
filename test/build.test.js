import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { JSDOM } from 'jsdom'

import { buildSite, buildTargets } from '../src/build.js'
import { listSites } from '../src/doctor.js'
import { makeSite, makeWorkspace, tinyPng, write } from './helpers.js'

const byId = (workspace, id) => listSites(workspace).find((site) => site.id === id)

test('构建成功：产物自包含，导航树与锚点都烘进 HTML', (t) => {
  const workspace = makeWorkspace(t)
  const { id } = makeSite(workspace)

  const result = buildSite(workspace, byId(workspace, id))
  assert.equal(result.ok, true)
  assert.equal(result.pages, 2)
  assert.equal(result.forced, false)

  const dist = join(workspace, 'sites', id, 'dist')
  for (const rel of ['index.html', 'login-doc.html', 'login-proto.html', 'kebab.css', 'kebab.svg', 'kebab.png']) {
    assert.ok(existsSync(join(dist, rel)), `缺产物：${rel}`)
  }
  assert.ok(existsSync(join(dist, 'prototypes', 'login-proto', 'index.html')), '原型目录原样复制')

  const html = readFileSync(join(dist, 'login-doc.html'), 'utf8')
  assert.match(html, /登录页改版说明/)
  assert.match(html, /新版登录页原型/, '导航树里有同模块的另一页')
  assert.ok(!/LO-0\d/.test(html), '产物里不再出现退役的 page code')
  assert.match(html, /class="is-current"/, '当前页要高亮')
  assert.match(html, /id="login-doc-1"/, '条目编号与锚点')
  assert.ok(!html.includes('<script'), '产物不带运行时脚本 —— file:// 下要能直接双击打开')
  assert.ok(!/(?:src|href)=["']?(?:https?:)?\/\//i.test(html), '产物不引公网资源')
})

test('图标随产物一起交付：SVG 加 PNG 兜底，每个页面都 link 它', (t) => {
  const workspace = makeWorkspace(t)
  const { id } = makeSite(workspace)
  buildSite(workspace, byId(workspace, id))

  const dist = join(workspace, 'sites', id, 'dist')
  const svg = readFileSync(join(dist, 'kebab.svg'), 'utf8')

  // 良构的 SVG —— 语法坏掉时 jsdom 会给出 parsererror 文档
  const dom = new JSDOM(svg, { contentType: 'image/svg+xml' })
  const root = dom.window.document.documentElement
  assert.equal(dom.window.document.querySelector('parsererror'), null)
  assert.equal(root.tagName.toLowerCase(), 'svg')
  assert.equal(root.getAttribute('viewBox'), '0 0 32 32')
  // 除 xmlns（一个标识符，不是请求）外不引任何公网地址
  assert.ok(!/https?:\/\//.test(svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '')), '图标不引公网资源')

  for (const file of ['index.html', 'login-doc.html', 'login-proto.html']) {
    const html = readFileSync(join(dist, file), 'utf8')
    assert.match(html, /href="kebab\.svg"/, `${file} 缺 SVG favicon`)
    assert.match(html, /href="kebab\.png"/, `${file} 缺 PNG favicon`)
  }

  // 位图兜底：留一张 32×32 的 PNG 给不肯拿 SVG 当 favicon 的浏览器（Edge）
  const png = readFileSync(join(dist, 'kebab.png'))
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG 签名',
  )
  assert.equal(png.readUInt32BE(16), 32, '宽 32')
  assert.equal(png.readUInt32BE(20), 32, '高 32')
})

test('下级页面也构建成独立页面，导航里缩在父级下面', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace, 'demo', (draft) => {
    draft.modules[0].pages[1].children = [{ id: 'login-proto-sub', type: 'doc', title: '原型补充说明' }]
    return draft
  })
  write(workspace, `sites/${id}/pages/login-proto-sub.md`, '## 一\n\n子页正文\n')

  const result = buildSite(workspace, byId(workspace, id))
  assert.equal(result.ok, true)
  assert.equal(result.pages, 3, '下级也算一页')

  const dist = join(workspace, 'sites', id, 'dist')
  assert.ok(existsSync(join(dist, 'login-proto-sub.html')), '下级有自己的产物页')

  const html = readFileSync(join(dist, 'login-doc.html'), 'utf8')
  const nav = html.match(/<nav class="kebab-nav">[\s\S]*?<\/nav>/)[0]
  assert.match(nav, /class="kebab-sub"/, '下级套一层 ul')
  // 下级要落在父级那一项里面
  const dom = new JSDOM(html)
  const sub = dom.window.document.querySelector('.kebab-sub')
  assert.equal(sub.closest('li').querySelector('a').getAttribute('href'), 'login-proto.html')
  assert.equal(sub.querySelector('a').getAttribute('href'), 'login-proto-sub.html')

  const overview = readFileSync(join(dist, 'index.html'), 'utf8')
  assert.match(overview, /class="kebab-sub"/, '概览页也递归')
})

test('正文里的 Markdown 表格落在正文容器里，且样式表给它框线', (t) => {
  const workspace = makeWorkspace(t)
  const { id } = makeSite(workspace)
  write(workspace, `sites/${id}/pages/login-doc.md`,
    '## 对比\n\n| 维度 | 单个新增 | 批量新增 |\n| --- | --- | --- |\n| 区块一 | 单一表单 | 共享 |\n')

  buildSite(workspace, byId(workspace, id))
  const dist = join(workspace, 'sites', id, 'dist')

  const html = readFileSync(join(dist, 'login-doc.html'), 'utf8')
  assert.match(html, /class="kebab-prose">[\s\S]*<table>/, '表格要落在 .kebab-prose 里，样式才吃得到')
  assert.match(html, /<th[^>]*>维度<\/th>/)

  // 浏览器默认不给 table 框线，样式表漏了这条规则产物里就是一片白 —— 这是踩过的坑
  const css = readFileSync(join(dist, 'kebab.css'), 'utf8')
  const cells = css.match(/\.kebab-prose th,\s*\.kebab-prose td \{[^}]*\}/)
  assert.ok(cells, 'kebab.css 少了表格单元格规则')
  assert.match(cells[0], /border:\s*1px solid/)
  assert.match(css, /\.kebab-prose table \{[\s\S]*?border-collapse:\s*collapse/)
  assert.match(css, /\.kebab-prose tbody tr:nth-child\(even\)\s*\{[^}]*background/, '表格要隔行浅底')

  // 表头与隔行底色都是 --kebab-bg。正文区若是同一个颜色，这两处浅底就白加了 —— 踩过这个坑
  const main = css.match(/\.kebab-main \{[^}]*\}/)[0]
  assert.match(main, /background:\s*var\(--kebab-panel\)/, '正文区要铺白底，表格的浅底才有对比')
})

test('围栏代码渲染成代码卡片，样式表给足了滚动、内边距与记号配色', (t) => {
  const workspace = makeWorkspace(t)
  const { id } = makeSite(workspace)
  write(workspace, `sites/${id}/pages/login-doc.md`,
    '## 契约\n\n```json\n{"dfromCode": "500103", "rid": true}\n```\n\n```text\n一段正文\n```\n')

  buildSite(workspace, byId(workspace, id))
  const dist = join(workspace, 'sites', id, 'dist')

  const html = readFileSync(join(dist, 'login-doc.html'), 'utf8')
  assert.match(html, /class="kebab-prose">[\s\S]*<div class="kebab-code" data-lang="json">/, '围栏要在正文里，而且是代码卡片')
  assert.match(html, /<span class="kebab-code-lang">json<\/span>/, '右上角挂语言牌子')
  assert.match(html, /<span class="kebab-tok-key">&quot;dfromCode&quot;<\/span>/, '键名要着好色')
  assert.match(html, /<span class="kebab-tok-literal">true<\/span>/)
  assert.match(html, /class="kebab-code is-text"/, 'text 围栏另走一套（折行、不挂牌子）')
  assert.ok(!html.includes('kebab-code-lang">text'), 'text 围栏不挂牌子，免得把正文挂成代码')

  // 这几条漏了，产物就是一片没有内边距、不能横向滚动的灰底 —— 踩过的坑
  const css = readFileSync(join(dist, 'kebab.css'), 'utf8')
  const block = css.match(/\.kebab-prose \.kebab-code-block \{[^}]*\}/)[0]
  assert.match(block, /overflow-x:\s*auto/)
  assert.match(block, /padding:\s*16px 18px/)
  assert.match(css, /\.kebab-prose \.kebab-code-block code \{[^}]*background:\s*none/, '块里的 code 要清掉行内 code 的底色')
  assert.match(css, /\.kebab-code\.is-text \.kebab-code-block \{[^}]*white-space:\s*pre-wrap/, 'text 围栏要折行')
  assert.match(css, /\.kebab-tok-key \{[^}]*color:/, '记号配色要跟样式表一起发出去')
})

test('正文图片点开可放大：走原生 popover，产物里仍没有一行脚本', (t) => {
  const workspace = makeWorkspace(t)
  const { id } = makeSite(workspace)
  write(workspace, `sites/${id}/pages/login-doc.md`,
    '## 截图\n\n![改版后的登录页](assets/login-after.png)\n\n'
    + '两张：![第一张](assets/a.png) 和 [![被链接的图](assets/b.png)](https://example.com/)\n')

  buildSite(workspace, byId(workspace, id))
  const html = readFileSync(join(join(workspace, 'sites', id, 'dist'), 'login-doc.html'), 'utf8')

  assert.ok(!html.includes('<script'), '放大不许引入脚本 —— file:// 下要能直接双击打开')

  const dom = new JSDOM(html)
  const doc = dom.window.document
  const triggers = [...doc.querySelectorAll('.kebab-prose .kebab-zoom')]
  assert.equal(triggers.length, 2, '正文里的两张独立图片各自可放大（链接里的那张不包）')
  assert.deepEqual(
    triggers.map((btn) => btn.tagName),
    ['BUTTON', 'BUTTON'],
    '放大件必须是按钮：popovertarget 只认 button 与 input',
  )

  triggers.forEach((btn) => {
    const target = btn.getAttribute('popovertarget')
    const view = doc.getElementById(target)
    assert.ok(view, `找不到 ${target} 对应的放大层`)
    assert.equal(view.getAttribute('popover'), '', 'popover 留空才是 auto —— Esc 与 light dismiss 才生效')
    assert.equal(view.getAttribute('role'), 'dialog')
    assert.ok(view.closest('.kebab-prose'), '放大层要留在正文里，样式才吃得到')
    assert.ok(view.querySelector('img'), '放大层里得有那张图')
    assert.ok(view.querySelector(`.kebab-zoom-out[popovertarget="${target}"]`), '放大层里要有接住空白处点击的按钮')
    assert.equal(btn.querySelector('img').getAttribute('src'), view.querySelector('img').getAttribute('src'))
  })

  // 两张图的 id 不同：同一个页面里 popover 的 id 撞车会开错层
  const ids = triggers.map((btn) => btn.getAttribute('popovertarget'))
  assert.equal(new Set(ids).size, 2)
  assert.match(ids[0], /^login-doc-zoom-\d+$/, 'id 带 page id，便于在产物里定位')

  // 已在链接里的图原样留着：按钮套进 a 里，一次点击会同时触发放大与跳转
  const linked = doc.querySelector('.kebab-prose a img')
  assert.ok(linked, '链接里的图还在')
  assert.equal(linked.closest('.kebab-zoom'), null)

  // 这几条样式漏了，点击要么关不掉，要么把图片挪位 —— 都是踩过的坑
  const css = readFileSync(join(workspace, 'sites', id, 'dist', 'kebab.css'), 'utf8')
  assert.match(css, /\.kebab-zoom \{[^}]*display:\s*inline/, '包一层按钮不许挪动图片在正文里的位置')
  const layer = css.match(/\.kebab-prose \.kebab-zoom-view:popover-open \{[^}]*\}/)[0]
  assert.match(layer, /position:\s*fixed/)
  assert.match(layer, /inset:\s*0/)
  assert.match(layer, /align-items:\s*safe center/, '不溢出居中、溢出顶头：长截图才滚得到头一行')
  assert.match(layer, /overflow:\s*auto/, '长截图在放大层里滚，而不是缩进视口')
  // 只卡宽度：高度上也卡一刀的话，整页/手机长截图点开反而比正文里更小
  const big = css.match(/\.kebab-prose \.kebab-zoom-view img \{[^}]*\}/)[0]
  assert.match(big, /max-width:\s*92vw/)
  assert.ok(!/max-height/.test(big), '放大件不许再卡高度')
  assert.match(css, /\.kebab-zoom-out \{[^}]*position:\s*fixed/, '接空白处的那颗透明按钮要铺满视口，长截图滚过一屏后还得在')
  assert.match(css, /\.kebab-zoom-view img \{[^}]*pointer-events:\s*none/, '点图也当点空白：交给透明按钮')
  assert.match(css, /\.kebab-zoom-view::backdrop \{[^}]*background/, '放大层背后要压暗')
  assert.match(css, /@supports not selector\(:popover-open\) \{\s*\.kebab-zoom-view \{ display: none/, '认不出 popover 的浏览器里，那份副本不能摊进正文')
})

test('导航树能收起：开关是一颗复选框，靠 :checked 的兄弟选择器生效', (t) => {
  const workspace = makeWorkspace(t)
  const { id } = makeSite(workspace)
  buildSite(workspace, byId(workspace, id))
  const dist = join(workspace, 'sites', id, 'dist')

  const dom = new JSDOM(readFileSync(join(dist, 'login-doc.html'), 'utf8'))
  const doc = dom.window.document
  const toggle = doc.querySelector('.kebab-nav-toggle')
  assert.ok(toggle, '每个页面都带这颗开关')
  assert.equal(toggle.tagName, 'INPUT')
  assert.equal(toggle.getAttribute('type'), 'checkbox', '不写脚本就只能靠复选框自己记状态')
  assert.equal(toggle.getAttribute('aria-label'), '收起左侧导航树')
  // 收起规则是 `.kebab-nav-toggle:checked ~ .kebab-shell …`：开关必须是 shell **前面的兄弟**，
  // 挪进 shell 里（或挪到它后面）整套选择器就不成立 —— 这是结构的一部分
  assert.equal(toggle.nextElementSibling.className, 'kebab-shell', '开关要挨着 .kebab-shell 且在它前面')
  assert.ok(doc.querySelector('.kebab-shell .kebab-nav'), '导航还在 shell 里')
  assert.ok(!readFileSync(join(dist, 'login-doc.html'), 'utf8').includes('<script'), '收起也不许引入脚本')

  // 概览页同一套骨架；门户页没有导航树，也就不该有这颗开关
  assert.match(readFileSync(join(dist, 'index.html'), 'utf8'), /class="kebab-nav-toggle"/)
  buildTargets(workspace, [id])
  assert.ok(
    !readFileSync(join(workspace, 'dist', 'index.html'), 'utf8').includes('kebab-nav-toggle'),
    '门户页没有导航树，别给它一颗点了没反应的开关',
  )

  // 这几条样式漏了，开关要么点了没反应，要么把藏起来的链接留在 Tab 里 —— 都是踩过的坑
  const css = readFileSync(join(dist, 'kebab.css'), 'utf8')
  assert.match(css, /--kebab-nav-width:\s*264px/)
  assert.match(css, /--kebab-nav-rail:\s*44px/)
  assert.match(css, /\.kebab-nav \{[^}]*flex:\s*0 0 var\(--kebab-nav-width\)/, '导航宽度要跟着变量走，收起才有地方改')
  assert.match(
    css,
    /\.kebab-nav-toggle:checked,\s*\.kebab-nav-toggle:checked ~ \.kebab-shell \{ --kebab-nav-width: var\(--kebab-nav-rail\); \}/,
    '一个变量同时管导航宽度与开关自己的位置',
  )
  assert.match(
    css,
    /\.kebab-nav-toggle:checked ~ \.kebab-shell \.kebab-brand,\s*\.kebab-nav-toggle:checked ~ \.kebab-shell \.kebab-tree \{ display: none; \}/,
    '收起时导航里的字要 display: none —— 用 visibility 藏的话，看不见的链接照样吃 Tab',
  )
  const toggleCss = css.match(/\.kebab-nav-toggle \{[^}]*\}/)[0]
  assert.match(toggleCss, /appearance:\s*none/, '复选框要自己画，不然露出的是系统那颗方框')
  assert.match(toggleCss, /position:\s*fixed/, '开关固定在视口上，长文档滚下去也够得着')
  assert.match(toggleCss, /left:\s*calc\(var\(--kebab-nav-width\) - 38px\)/)
  assert.match(css, /\.kebab-nav-toggle::before \{[^}]*border-left[^}]*rotate\(45deg\)/s, '雪佛龙靠两条边拼，不额外引图标文件')
  assert.match(css, /\.kebab-nav-toggle:checked::before \{[^}]*rotate\(-135deg\)/, '收起后箭头要掉头指向右')
  assert.match(css, /\.kebab-brand \{[^}]*padding:\s*0 46px 16px 20px/, '标题右边让出开关的位置，长标题才不会钻到按钮底下')
})

test('正文栏跟着窗口走，不留 880px 那种死上限', (t) => {
  const workspace = makeWorkspace(t)
  const { id } = makeSite(workspace)
  buildSite(workspace, byId(workspace, id))
  const css = readFileSync(join(workspace, 'sites', id, 'dist', 'kebab.css'), 'utf8')

  const doc = css.match(/\.kebab-doc \{[^}]*\}/)[0]
  const cap = Number(doc.match(/max-width:\s*(\d+)px/)[1])
  // 要的是「右边那一大块空白没了」：1440 / 1707 / 1920 这些常见宽度都得铺得满
  assert.ok(cap >= 1440, `正文栏上限 ${cap}px 太窄，1920 的屏上又会挂一块空白`)
  // 但也不能一路铺到超宽屏的边：一行中文两千字，读起来就散了
  assert.ok(cap <= 1800, `正文栏上限 ${cap}px 太宽，超宽屏上一行拉太长`)
  assert.match(doc, /padding:\s*36px 48px 80px/, '正文栏的边距不跟着宽度一起长')
})

test('悬空引用拦住构建，不出产物', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)
  rmSync(join(dir, 'pages', 'login-doc.md'))

  const result = buildSite(workspace, byId(workspace, id))
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'doctor')
  assert.ok(result.problems.some((problem) => problem.kind === 'dangling'))
  assert.ok(!existsSync(join(dir, 'dist', 'index.html')))
})

test('孤儿文件与闲置素材不拦构建，只当提示带回来', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)
  write(workspace, `sites/${id}/pages/extra.md`, '## 孤儿\n')
  write(workspace, `sites/${id}/assets/left.png`, tinyPng)

  const result = buildSite(workspace, byId(workspace, id))
  assert.equal(result.ok, true)
  assert.deepEqual(
    result.problems.map((problem) => problem.kind).sort(),
    ['orphan', 'unused-asset'],
  )
  assert.ok(existsSync(join(dir, 'dist', 'index.html')), '产物照样出来')
})

test('导入校验拦下时不出产物，--force 放行且把问题带回来', (t) => {
  const workspace = makeWorkspace(t)
  const { id, dir } = makeSite(workspace)
  write(workspace, `sites/${id}/prototypes/login-proto/index.html`, '<script type="module" src="app.js"></script>')

  const blocked = buildSite(workspace, byId(workspace, id))
  assert.equal(blocked.ok, false)
  assert.equal(blocked.stage, 'import-check')
  assert.ok(!existsSync(join(dir, 'dist', 'index.html')))

  const forced = buildSite(workspace, byId(workspace, id), { force: true })
  assert.equal(forced.ok, true)
  assert.equal(forced.forced, true)
  assert.ok(forced.problems.some((problem) => problem.kind === 'module-script'))
  assert.ok(existsSync(join(dir, 'dist', 'index.html')))
})

test('门户页列出全部产品原型，未构建的标出来且不可点', (t) => {
  const workspace = makeWorkspace(t)
  makeSite(workspace, 'good')
  makeSite(workspace, 'later')

  const { allOk, portal } = buildTargets(workspace, ['good'])
  assert.equal(allOk, true)
  assert.deepEqual(portal, { ready: 1, total: 2 })

  const html = readFileSync(join(workspace, 'dist', 'index.html'), 'utf8')
  assert.match(html, /尚未构建/)
  assert.match(html, /\.\.\/sites\/good\/dist\/index\.html/)
  assert.match(html, /href="kebab\.svg"/, '门户页也带图标')
  assert.ok(existsSync(join(workspace, 'dist', 'kebab.svg')))
})

test('只要有一个失败，门户页就保持原样', (t) => {
  const workspace = makeWorkspace(t)
  makeSite(workspace, 'good')
  makeSite(workspace, 'broken')
  buildTargets(workspace, ['good'])
  const before = readFileSync(join(workspace, 'dist', 'index.html'), 'utf8')

  rmSync(join(workspace, 'sites', 'broken', 'pages', 'login-doc.md')) // 悬空引用，这个会拦住构建
  const second = buildTargets(workspace, [])
  assert.equal(second.allOk, false)
  assert.equal(second.portal, null)
  assert.equal(readFileSync(join(workspace, 'dist', 'index.html'), 'utf8'), before, '门户页没被动过')
  assert.ok(existsSync(join(workspace, 'sites', 'good', 'dist', 'index.html')), '成功的那个照样产出')

  write(workspace, 'sites/broken/pages/login-doc.md', '## 调整背景\n\n正文\n')
  const third = buildTargets(workspace, [])
  assert.equal(third.allOk, true)
  assert.deepEqual(third.portal, { ready: 2, total: 2 })
})
