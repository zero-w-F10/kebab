import { register } from 'node:module'
import assert from 'node:assert/strict'
import test from 'node:test'

import { installDom } from './dom.js'

/**
 * 编辑器前端的交互回归：双击改名、行尾的「⋯」菜单、顶部工具栏、拖拽排序。
 *
 * 直接加载 src 下的源码（CSS 导入由 test/css-hooks.js 吃掉），再用 jsdom 假装浏览器去点它。
 * 服务端用假的 fetch 顶掉 —— 这一层测的是点下去发生什么，不是磁盘上写了什么，
 * 后者在 store/api 的测试里。
 */

register('./css-hooks.js', import.meta.url)

const MAIN = new URL('../src/editor/ui/main.js', import.meta.url).href

const realFetch = globalThis.fetch
const realSetInterval = globalThis.setInterval

test.after(() => {
  globalThis.fetch = realFetch
  globalThis.setInterval = realSetInterval
})

const site = () => ({
  site: { title: '演示站点', subtitle: 'V1' },
  modules: [
    {
      id: 'login',
      title: '登录',
      pages: [
        { id: 'login-flow', type: 'proto', title: '登录流程图' },
        { id: 'login-doc', type: 'doc', title: '登录说明' },
      ],
    },
  ],
})

let caseId = 0

/**
 * 装 DOM、假装服务端、把前端跑起来，返回可断言的 document 与收到的请求。
 *
 * `responses` 按路径给假响应；轮询定时器换成手工把手（`tick()`），
 * `setState()` 换掉下次 /api/state 会读到的东西 —— 用来演「磁盘被外部改了」。
 */
async function bootEditor({ problems = [], tree = site(), responses = {}, notFound = [] } = {}) {
  installDom()
  const document = globalThis.document
  document.body.innerHTML = '<div id="app"></div>'

  let poll = null
  let current = { revision: 'r1', problems }
  globalThis.setInterval = (fn) => {
    poll = fn
    return 0
  }

  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url))
    calls.push({
      method: options.method ?? 'GET',
      path: parsed.pathname,
      body: options.body ? JSON.parse(options.body) : null,
    })
    if (notFound.includes(parsed.pathname)) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: `没有这个接口：${options.method ?? 'GET'} ${parsed.pathname}` }),
      }
    }
    const payload = parsed.pathname === '/api/state'
      ? { sites: [{ id: 'demo' }], id: 'demo', revision: current.revision, site: tree, problems: current.problems }
      : responses[parsed.pathname] ?? {}
    return { ok: true, status: 200, json: async () => payload }
  }

  await import(`${MAIN}?case=${caseId += 1}`)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
  return {
    document,
    window: globalThis.window,
    calls,
    tick: async () => { await poll(); await settle() },
    setState: (next) => { current = { ...current, ...next } },
    settle,
  }
}

/**
 * jsdom 不做排版，getBoundingClientRect 一律返回零框；拖拽的落点靠「指针在这一行的
 * 上半还是下半」判断，所以这里给每行喂一个盒子：page 行 20px，module 头 30px。
 */
function layout(document) {
  const stub = (node, top, height) => {
    node.getBoundingClientRect = () => ({ top, height })
    return node
  }
  const rows = [...document.querySelectorAll('.side .page')]
  rows.forEach((row, index) => stub(row, index * 20, 20))
  const heads = [...document.querySelectorAll('.side .module-head')]
  heads.forEach((head, index) => stub(head, index * 30, 30))
  return { rows, heads }
}

/** 从第 from 行拖到第 to 行的上沿/中段/下沿：握把是起点，整行是落点。 */
function dragRow(window, rows, from, to, where = 'before') {
  const event = (type, clientY) => {
    const node = new window.Event(type, { bubbles: true, cancelable: true })
    // 真浏览器里由拖拽会话提供，这里给个最小的替身
    node.dataTransfer = { effectAllowed: '', dropEffect: '', setData() {}, getData: () => '' }
    node.clientY = clientY
    return node
  }
  const rect = rows[to].getBoundingClientRect()
  const y = where === 'after' ? rect.top + rect.height - 1
    : where === 'into' ? rect.top + rect.height / 2
      : rect.top + 1
  const source = rows[from]
  source.querySelector('.grip').dispatchEvent(event('dragstart'))
  rows[to].dispatchEvent(event('dragover', y))
  rows[to].dispatchEvent(event('drop', y))
  source.querySelector('.grip').dispatchEvent(event('dragend'))
}

test('工作区级的按钮都在顶部工具栏，核对带问题角标', async () => {
  const { document } = await bootEditor({
    problems: [
      { kind: 'dangling', message: 'pages/x.md 不见了' },
      { kind: 'orphan', path: 'pages/y.md', message: 'pages/y.md 没被引用' },
      { kind: 'unused-asset', path: 'assets/z.png', message: '闲置素材：assets/z.png 没有被任何 doc 页引用' },
    ],
  })

  for (const id of ['new-module', 'problems-btn', 'build', 'reload', 'save']) {
    assert.ok(document.getElementById(id), `顶部工具栏少了 ${id}`)
  }
  // 标签页标题带站点名，图标在品牌位
  assert.equal(document.title, '演示站点 - Kebab 编辑器')
  assert.equal(document.getElementById('problems-count').textContent, '3')
  // 底栏那套已经收进顶栏
  assert.equal(document.querySelector('.foot'), null)
  assert.equal(document.querySelector('.side-foot'), null)
  assert.ok(document.querySelector('.bar-brand .brand-logo'), '顶栏品牌位带图标')

  assert.equal(document.getElementById('problems-btn').classList.contains('alert'), true)

  document.getElementById('problems-btn').click()
  const rows = [...document.querySelectorAll('.modal-box .problem')]
  assert.equal(rows.length, 3)
  assert.match(document.querySelector('.modal-box h2').textContent, /核对/)

  // 闲置素材那一行有它自己的出口
  const unused = rows.find((row) => row.textContent.includes('闲置'))
  assert.ok(unused, '闲置素材要出现在核对面板里')
  unused.querySelector('.more').click()
  assert.deepEqual(
    [...document.querySelectorAll('.menu .menu-item')].map((node) => node.textContent),
    ['删除文件'],
  )
})

test('树节点平时是文字，双击就地改名，Enter 提交、Esc 放弃', async () => {
  const { document, window } = await bootEditor()
  const dblclick = (node) => node.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))
  const escape = (node) => node.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const enter = (node) => node.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

  // 平时是只读文字，不是常驻输入框
  assert.equal(document.querySelector('.page .node-title').textContent, '登录流程图')
  assert.equal(document.querySelector('.page input'), null)

  dblclick(document.querySelector('.page .node-title'))
  const input = document.querySelector('.page .inline-edit')
  assert.equal(input.value, '登录流程图')

  input.value = '  登录流程图（改）　'
  enter(input)
  assert.equal(document.querySelector('.page .inline-edit'), null)
  assert.equal(document.querySelector('.page .node-title').textContent, '登录流程图（改）')
  assert.equal(document.getElementById('save').disabled, false)
  assert.match(document.getElementById('status').textContent, /未保存/)

  // Esc 放弃改动，标题回到原名
  dblclick(document.querySelector('.module-head .node-title'))
  const moduleInput = document.querySelector('.module-head .inline-edit')
  moduleInput.value = '不该生效'
  escape(moduleInput)
  assert.equal(document.querySelector('.module-head .node-title').textContent, '登录')
})

test('行尾的「⋯」弹出该节点的操作菜单', async () => {
  const { document } = await bootEditor()
  const labels = () => [...document.querySelectorAll('.menu .menu-item')].map((node) => node.textContent)

  document.querySelector('.page .more').click()
  assert.deepEqual(labels(), ['新建下级页面', '重命名', '删除页面'])

  // 换一行点：旧的菜单收起，新的菜单贴着这一行
  document.querySelector('.module-head .more').click()
  assert.deepEqual(labels(), ['新建 doc 页', '新建 proto 页', '重命名', '删除模块'])

  document.querySelector('.menu .menu-item.danger').click()
  assert.equal(document.querySelector('.menu'), null, '点完菜单项应把菜单收起来')
  assert.match(document.querySelector('.modal-box h2').textContent, /删除模块/)
})

test('菜单里的「重命名」与双击是同一件事', async () => {
  const { document } = await bootEditor()
  document.querySelector('.module-head .more').click()
  const rename = [...document.querySelectorAll('.menu .menu-item')].find((node) => node.textContent === '重命名')
  rename.click()
  assert.ok(document.querySelector('.module-head .inline-edit'), '菜单应把标题变成输入框')
})

/** 拖拽排序用得上的树：一个 module 三页，再加一个 module 用来验跨模块不搬。 */
const dragTree = () => ({
  site: { title: '拖拽演示' },
  modules: [
    {
      id: 'login',
      title: '登录',
      pages: [
        { id: 'p1', type: 'doc', title: '第一页' },
        { id: 'p2', type: 'doc', title: '第二页' },
        { id: 'p3', type: 'doc', title: '第三页' },
      ],
    },
    {
      id: 'order',
      title: '订单',
      pages: [{ id: 'p4', type: 'doc', title: '订单页' }],
    },
  ],
})

test('拖页面握把改先后顺序：按行的上半/下半插到它前面或后面', async () => {
  const { document, window } = await bootEditor({ tree: dragTree() })
  const order = () => [...document.querySelectorAll('.side .page')].map((row) => row.dataset.pageId)

  assert.deepEqual(order(), ['p1', 'p2', 'p3', 'p4'])

  // 拖到自己身上是空操作，也不该把树标成有未保存的改动
  dragRow(window, layout(document).rows, 1, 1, 'before')
  assert.deepEqual(order(), ['p1', 'p2', 'p3', 'p4'])
  assert.equal(document.getElementById('save').disabled, true, '原地拖不该把树标脏')

  // 第一页拖到第三页的下半 —— 落到它后面
  dragRow(window, layout(document).rows, 0, 2, 'after')
  assert.deepEqual(order(), ['p2', 'p3', 'p1', 'p4'])
  assert.equal(document.getElementById('save').disabled, false, '重排后应变成有未保存的改动')

  // 再把它拖回第一页的上半
  dragRow(window, layout(document).rows, 2, 0, 'before')
  assert.deepEqual(order(), ['p1', 'p2', 'p3', 'p4'])
})

test('page 可以拖进别的 module：正文位置由 id 推出，搬了没有副作用', async () => {
  const { document, window, calls } = await bootEditor({ tree: dragTree() })
  const order = () => [...document.querySelectorAll('.side .page')].map((row) => row.dataset.pageId)

  // 把 login 的第一页拖到 order 那一页的上半
  dragRow(window, layout(document).rows, 0, 3, 'before')
  assert.deepEqual(order(), ['p2', 'p3', 'p1', 'p4'], 'p1 进了 order，排在 p4 前面')

  document.getElementById('save').click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const saved = calls.find((call) => call.path === '/api/tree')
  assert.deepEqual(
    saved.body.tree.modules.map((mod) => [mod.id, mod.pages.map((page) => page.id)]),
    [['login', ['p2', 'p3']], ['order', ['p1', 'p4']]],
    '清单里换了模块，id 一个没动 —— 没有文件要搬',
  )
})

test('拖进空 module：整块是落点，放在末尾', async () => {
  const tree = dragTree()
  tree.modules.push({ id: 'blank', title: '空模块', pages: [] })
  const { document, window } = await bootEditor({ tree })

  const { rows, heads } = layout(document)
  const blank = heads[2]
  assert.equal(blank.textContent.includes('空模块'), true)

  const event = (type) => {
    const node = new window.Event(type, { bubbles: true, cancelable: true })
    node.dataTransfer = { effectAllowed: '', dropEffect: '', setData() {}, getData: () => '' }
    node.clientY = 0
    return node
  }
  // 空 module 里没有 page 行可落，落点是整块 module
  const blankModule = heads[2].closest('.module')
  rows[0].querySelector('.grip').dispatchEvent(event('dragstart'))
  blankModule.dispatchEvent(event('dragover'))
  assert.equal(blankModule.classList.contains('drop-into'), true, '整块 module 描一圈')
  blankModule.dispatchEvent(event('drop'))

  const ids = [...document.querySelectorAll('.side .page')].map((row) => row.dataset.pageId)
  assert.deepEqual(ids, ['p2', 'p3', 'p4', 'p1'], 'p1 落到空模块里')
})

test('拖模块握把改模块顺序，保存时送出去的就是屏幕上的顺序', async () => {
  const { document, window, calls } = await bootEditor({ tree: dragTree() })
  const titles = () => [...document.querySelectorAll('.side .module-head .node-title')].map((node) => node.textContent)

  assert.deepEqual(titles(), ['登录', '订单'])
  dragRow(window, layout(document).heads, 0, 1, 'after')
  assert.deepEqual(titles(), ['订单', '登录'])
  assert.equal(document.getElementById('save').disabled, false, '重排后应变成有未保存的改动')

  document.getElementById('save').click()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const saved = calls.find((call) => call.path === '/api/tree')
  assert.ok(saved, '保存应把整棵树发给服务端')
  assert.deepEqual(saved.body.tree.modules.map((mod) => mod.id), ['order', 'login'])
  assert.deepEqual(saved.body.tree.modules[0].pages.map((page) => page.id), ['p4'])
})

test('拖拽只改顺序，不改 page id 与文件位置', async () => {
  const { document, window, calls } = await bootEditor({ tree: dragTree() })
  dragRow(window, layout(document).rows, 2, 0, 'before') // p3 挪到最前

  const rows = [...document.querySelectorAll('.side .page')].map((row) => [
    row.dataset.pageId,
    row.querySelector('.node-title').textContent,
  ])
  assert.deepEqual(rows, [['p3', '第三页'], ['p1', '第一页'], ['p2', '第二页'], ['p4', '订单页']], 'id 跟着页面走，不重编')

  document.getElementById('save').click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const saved = calls.find((call) => call.path === '/api/tree')
  assert.deepEqual(
    saved.body.tree.modules[0].pages.map((page) => page.id),
    ['p3', 'p1', 'p2'],
    '顺序进了清单，id 一个没动',
  )
})

test('导航树与内容区都不再显示退役的编号', async () => {
  const { document } = await bootEditor()
  assert.equal(document.querySelector('.side .code'), null, '树上没有编号列')
  assert.equal(document.querySelector('.side .prefix'), null, '模块行没有前缀')

  // 内容区头部只留标题与文件位置
  document.querySelector('.side .page').click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const head = document.querySelector('.pane-head')
  assert.match(head.textContent, /登录流程图/)
  assert.ok(!/LO-0\d/.test(head.textContent), '内容区头部不再出现编号')
})

/* ---------- 页面嵌套 ---------- */

/** 带一层下级的树：A 下面是 a1，B 跟 A 同级。 */
const nestedTree = () => ({
  site: { title: '嵌套演示' },
  modules: [
    {
      id: 'login',
      title: '登录',
      pages: [
        { id: 'a', type: 'doc', title: 'A', children: [{ id: 'a1', type: 'doc', title: 'A 的补充说明' }] },
        { id: 'b', type: 'doc', title: 'B' },
      ],
    },
  ],
})

test('下级缩进在父级下面，缩进量跟着层级走', async () => {
  const { document } = await bootEditor({ tree: nestedTree() })
  const rows = [...document.querySelectorAll('.side .page')]

  assert.deepEqual(rows.map((row) => row.dataset.pageId), ['a', 'a1', 'b'], '前序：下级紧跟父级')
  assert.equal(rows[0].style.getPropertyValue('--depth'), '1')
  assert.equal(rows[1].style.getPropertyValue('--depth'), '2')
  assert.equal(rows[2].style.getPropertyValue('--depth'), '1')

  // 下级挂在自己那一项里面，而不是跟父级平铺
  const group = rows[0].closest('.page-item')
  assert.equal(group.querySelectorAll('.page').length, 2, 'A 那一项里包含它自己和 a1')
})

test('拖到行的中段 = 变成它的下级', async () => {
  const { document, window, calls } = await bootEditor({ tree: nestedTree() })
  const ids = () => [...document.querySelectorAll('.side .page')].map((row) => row.dataset.pageId)
  const depthOf = (id) => document.querySelector(`[data-page-id="${id}"]`).style.getPropertyValue('--depth')

  assert.deepEqual(ids(), ['a', 'a1', 'b'])

  // a1 拖到 B 的中段 —— 从 A 的下级改挂到 B 下面。前序因此变了，说明真的搬了
  dragRow(window, layout(document).rows, 1, 2, 'into')
  assert.deepEqual(ids(), ['a', 'b', 'a1'])
  assert.equal(depthOf('a1'), '2', '还是二级，但换了父级')
  assert.equal(depthOf('b'), '1')
  assert.equal(document.querySelector('[data-page-id="a"]').closest('.page-item').querySelectorAll('.page').length, 1, 'A 下面空了')
  assert.equal(document.querySelector('[data-page-id="b"]').closest('.page-item').querySelectorAll('.page').length, 2, 'a1 挂在 B 下面')

  document.getElementById('save').click()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const saved = calls.find((call) => call.path === '/api/tree')
  assert.deepEqual(
    saved.body.tree.modules[0].pages.map((page) => [page.id, (page.children ?? []).map((child) => child.id)]),
    [['a', []], ['b', ['a1']]],
  )
})

test('拖到行的上/下沿 = 跟它同级，可以把下级拖回顶层', async () => {
  const { document, window } = await bootEditor({ tree: nestedTree() })
  const ids = () => [...document.querySelectorAll('.side .page')].map((row) => row.dataset.pageId)
  const depthOf = (id) => document.querySelector(`[data-page-id="${id}"]`).style.getPropertyValue('--depth')

  assert.equal(depthOf('a1'), '2')
  // a1 拖到 B 的下沿 —— 变成跟 B 同级的顶层页面
  dragRow(window, layout(document).rows, 1, 2, 'after')
  assert.deepEqual(ids(), ['a', 'b', 'a1'])
  assert.equal(depthOf('a1'), '1', '回到顶层')

  // 再把它拖回 A 的中段
  dragRow(window, layout(document).rows, 2, 0, 'into')
  assert.deepEqual(ids(), ['a', 'a1', 'b'])
  assert.equal(depthOf('a1'), '2')
})

test('不能把一页拖进它自己的后代里', async () => {
  const { document, window } = await bootEditor({ tree: nestedTree() })
  const ids = () => [...document.querySelectorAll('.side .page')].map((row) => row.dataset.pageId)

  // A 拖到自己的下级 a1 的中段：那是它自己的后代，不接
  const { rows } = layout(document)
  const source = rows[0]
  const event = (type, clientY) => {
    const node = new window.Event(type, { bubbles: true, cancelable: true })
    node.dataTransfer = { effectAllowed: '', dropEffect: '', setData() {}, getData: () => '' }
    node.clientY = clientY
    return node
  }
  const rect = rows[1].getBoundingClientRect()
  source.querySelector('.grip').dispatchEvent(event('dragstart'))
  rows[1].dispatchEvent(event('dragover', rect.top + rect.height / 2))
  assert.equal(document.querySelectorAll('.drop-into').length, 0, '不该画落点')
  rows[1].dispatchEvent(event('drop', rect.top + rect.height / 2))

  assert.deepEqual(ids(), ['a', 'a1', 'b'], '结构没变')
  assert.equal(document.getElementById('save').disabled, true, '不该标脏')
})

test('删带下级的页：确认框报出下级条数，选中被删时一起清掉', async () => {
  const { document } = await bootEditor({ tree: nestedTree() })

  // 先选中下级，再删它的父级
  document.querySelector('[data-page-id="a1"]').click()
  await new Promise((resolve) => setTimeout(resolve, 20))

  document.querySelector('[data-page-id="a"] .more').click()
  const remove = [...document.querySelectorAll('.menu .menu-item')].find((node) => node.textContent === '删除页面')
  remove.click()

  assert.match(document.querySelector('.modal-box h2').textContent, /连同 1 个下级页面/)
  assert.match(document.querySelector('.modal-box .modal-check').textContent, /这 2 个页面/)
})

test('页面菜单能直接建下级', async () => {
  const { document } = await bootEditor({ tree: nestedTree() })
  document.querySelector('[data-page-id="b"] .more').click()
  const create = [...document.querySelectorAll('.menu .menu-item')].find((node) => node.textContent === '新建下级页面')
  create.click()
  assert.match(document.querySelector('.modal-box h2').textContent, /在「B」下新建页面/)
})

/* ---------- 孤儿 md 的收编 ---------- */

const orphan = (path) => ({ kind: 'orphan', path, message: `孤儿文件：${path} 没有被清单引用` })

test('服务端还是旧进程时，报错要说清「重启编辑器」', async () => {
  // 前端每次请求都现读磁盘上的 bundle，服务端是启动时载入的：改了代码而不重启就会这样
  const { document, settle } = await bootEditor({
    problems: [orphan('pages/说明.md')],
    notFound: ['/api/orphans/plan'],
  })

  document.getElementById('problems-btn').click()
  const bulk = [...document.querySelectorAll('.modal-actions button')]
    .find((node) => node.textContent.includes('全部收编'))
  bulk.click()
  await settle()

  const text = document.getElementById('notice').textContent
  assert.match(text, /没有这个接口/)
  assert.match(text, /重启/)
})

test('外部丢进 pages/ 的 md：轮询一到，核对角标与提示立刻跟上', async () => {
  const { document, tick, setState } = await bootEditor()
  assert.equal(document.getElementById('problems-count').textContent, '0')

  // 模拟有人把文件拷进 pages/：指纹变了，孤儿文件出现在新的核对结果里
  setState({ revision: 'r2', problems: [orphan('pages/说明.md')] })
  await tick()

  assert.equal(document.getElementById('problems-count').textContent, '1', '角标要跟着新文件走，不用手动重载')
  assert.match(document.getElementById('notice').textContent, /没进清单/)
  assert.equal(document.getElementById('status').textContent, '陈旧')
})

test('核对面板能一次把 pages/ 下的孤儿 md 收编成 doc 页', async () => {
  const items = [
    { path: 'pages/extra.md', kind: 'doc', id: 'extra', title: '附注', renamed: null, titleFromHeading: true },
    { path: 'pages/说明.md', kind: 'doc', id: 'doc-1', title: '收编说明', renamed: 'doc-1.md', titleFromHeading: true },
  ]
  const { document, window, calls, settle } = await bootEditor({
    problems: [orphan('pages/extra.md'), orphan('pages/说明.md')],
    responses: {
      '/api/orphans/plan': { items, skipped: [] },
      '/api/orphans/import': { id: 'demo', revision: 'r2', site: site(), problems: [], imported: items, skipped: [] },
    },
  })

  document.getElementById('problems-btn').click()
  const bulk = [...document.querySelectorAll('.modal-actions button')]
    .find((node) => node.textContent.includes('全部收编'))
  assert.ok(bulk, '核对面板要有批量出口')
  assert.match(bulk.textContent, /2 个 md/)

  bulk.click()
  await settle()
  const box = document.querySelector('.modal-box')
  assert.match(box.querySelector('h2').textContent, /收编 2 个 md/)
  assert.match(box.textContent, /pages\/说明\.md → pages\/doc-1\.md/, '改名要在动手前列出来')
  assert.match(box.textContent, /收编说明/)

  box.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await settle()

  const call = calls.find((item) => item.path === '/api/orphans/import')
  assert.deepEqual(call.body.items, [{ path: 'pages/extra.md' }, { path: 'pages/说明.md' }])
  assert.equal(call.body.moduleId, 'login')
  assert.equal(call.body.baseRevision, 'r1')
  // 收编回执另开一个面板，改名与落点都写清楚
  const report = document.querySelector('.modal-box')
  assert.match(report.querySelector('h2').textContent, /收编结果/)
  assert.match(report.textContent, /已收编 2 页/)
  assert.match(report.textContent, /pages\/doc-1\.md（原 pages\/说明\.md）/)
})

test('陈旧但没有本地改动时，收编先自己重载一次再落盘', async () => {
  const items = [{ path: 'pages/说明.md', kind: 'doc', id: 'doc-1', title: '收编说明', renamed: 'doc-1.md', titleFromHeading: true }]
  const { document, window, calls, tick, setState, settle } = await bootEditor({
    responses: {
      '/api/orphans/plan': { items, skipped: [] },
      '/api/orphans/import': { id: 'demo', revision: 'r3', site: site(), problems: [], imported: items, skipped: [] },
    },
  })

  // 丢文件进 pages/ 的那一刻状态就是陈旧的 —— 这正是要收编的场景
  setState({ revision: 'r2', problems: [orphan('pages/说明.md')] })
  await tick()
  assert.equal(document.getElementById('status').textContent, '陈旧')

  document.getElementById('problems-btn').click()
  const bulk = [...document.querySelectorAll('.modal-actions button')]
    .find((node) => node.textContent.includes('全部收编'))
  const reads = () => calls.filter((item) => item.path === '/api/state').length
  const before = reads()

  bulk.click()
  await settle()
  document.querySelector('.modal-box').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await settle()

  assert.equal(reads(), before + 1, '落盘前应自己重载一次，不能拿陈旧指纹去撞 409')
  const posted = calls.find((item) => item.path === '/api/orphans/import')
  assert.equal(posted.body.baseRevision, 'r2', '用的是重载后的指纹')
  assert.match(document.querySelector('.modal-box h2').textContent, /收编结果/)
})

test('逐行收编时 page id 与标题按计划预填，改 id 相当于给文件改名', async () => {
  const { document, window, calls, settle } = await bootEditor({
    problems: [orphan('pages/说明.md')],
    responses: {
      '/api/orphans/plan': {
        items: [{ path: 'pages/说明.md', kind: 'doc', id: 'doc-1', title: '收编说明', renamed: 'doc-1.md', titleFromHeading: true }],
        skipped: [],
      },
      '/api/orphan/import': { id: 'demo', revision: 'r2', site: site(), problems: [], imported: [], skipped: [] },
    },
  })

  document.getElementById('problems-btn').click()
  document.querySelector('.modal-box .problem .more').click()
  const entry = [...document.querySelectorAll('.menu .menu-item')].find((node) => node.textContent === '收编为页面')
  entry.click()
  await settle()

  const box = document.querySelector('.modal-box')
  const fields = [...box.querySelectorAll('.modal-field input')]
  assert.deepEqual(fields.map((node) => node.value), ['doc-1', '收编说明'])
  assert.match(box.textContent, /文件名得改成 doc-1\.md/)

  fields[0].value = 'intro'
  box.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await settle()

  const call = calls.find((item) => item.path === '/api/orphan/import')
  assert.deepEqual(call.body, {
    path: 'pages/说明.md',
    moduleId: 'login',
    pageId: 'intro',
    title: '收编说明',
    baseRevision: 'r1',
    withFiles: false, // 弹层的公共字段，收编用不上
  })
})
