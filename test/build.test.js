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
