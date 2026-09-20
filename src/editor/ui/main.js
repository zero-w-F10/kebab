import './style.css'
// Crepe 的主题按需引，不带 latex（那一份会拖进 katex 字体）。放这里而不是
// doc-editor.js，是为了让后者保持纯 JS —— 测试能直接 import 它。
import '@milkdown/crepe/theme/common/prosemirror.css'
import '@milkdown/crepe/theme/common/reset.css'
import '@milkdown/crepe/theme/common/block-edit.css'
import '@milkdown/crepe/theme/common/code-mirror.css'
import '@milkdown/crepe/theme/common/cursor.css'
import '@milkdown/crepe/theme/common/image-block.css'
import '@milkdown/crepe/theme/common/link-tooltip.css'
import '@milkdown/crepe/theme/common/list-item.css'
import '@milkdown/crepe/theme/common/placeholder.css'
import '@milkdown/crepe/theme/common/toolbar.css'
import '@milkdown/crepe/theme/common/table.css'
import '@milkdown/crepe/theme/classic.css'
import { isRealChange, mountDocEditor } from './doc-editor.js'

/**
 * 编辑器前端。刻意用原生 DOM：界面只有一条顶部工具栏、一棵导航树和一个内容区，
 * 为此引入框架只会多出一层要协调的东西。
 * 交互照 axhub make 那一路工具的习惯来：双击就地改名，每个节点的操作收进行尾的
 * 「⋯」菜单，工作区级的动作（新建模块、核对、构建、重载、保存）都摆在顶部工具栏。
 * 所有写操作都带上内存里的 revision，服务端据此判定陈旧写入（docs/adr/0006）。
 */

/* ---------- DOM 小工具 ---------- */

function h(tag, props, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'value') node.value = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else node.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

const clear = (node, ...children) => {
  node.replaceChildren(...children.flat().filter((child) => child !== null && child !== undefined))
  return node
}

/* ---------- 状态 ---------- */

const state = {
  sites: [],
  siteId: null,
  tree: null,
  revision: null,
  problems: [],
  selected: null, // { id, type }
  doc: { id: null, text: '', dirty: false },
  treeDirty: false,
  stale: false,
  notice: null, // { kind: 'info' | 'error', text }
}

/* ---------- 与服务端对话 ---------- */

async function request(method, path, { params, body } = {}) {
  const url = new URL(path, location.origin)
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value)
  }
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json().catch(() => ({}))
  if (response.status === 409) {
    markStale()
    throw new Error('磁盘内容已被外部改动，请先重载')
  }
  if (!response.ok) throw new Error(payload.error ?? `请求失败（HTTP ${response.status}）`)
  return payload
}

const base = () => ({ baseRevision: state.revision })

const api = {
  state: () => request('GET', '/api/state'),
  doc: (id) => request('GET', '/api/doc', { params: { id } }),
  saveTree: (tree) => request('POST', '/api/tree', { body: { tree, ...base() } }),
  saveDoc: (id, text) => request('POST', '/api/doc/save', { body: { id, text, ...base() } }),
  createPage: (payload) => request('POST', '/api/page/create', { body: { ...payload, ...base() } }),
  deletePage: (id, withFiles) => request('POST', '/api/page/delete', { body: { id, withFiles, ...base() } }),
  createModule: (payload) => request('POST', '/api/module/create', { body: { ...payload, ...base() } }),
  deleteModule: (id, withFiles) => request('POST', '/api/module/delete', { body: { id, withFiles, ...base() } }),
  build: (force) => request('POST', '/api/build', { body: { force } }),
  importOrphan: (payload) => request('POST', '/api/orphan/import', { body: { ...payload, ...base() } }),
  deleteOrphan: (path) => request('POST', '/api/orphan/delete', { body: { path, ...base() } }),
  deleteUnusedAsset: (path) => request('POST', '/api/asset/delete', { body: { path, ...base() } }),
}

/* ---------- 状态变更 ---------- */

function applyState(payload) {
  if (payload.sites) state.sites = payload.sites
  if (payload.id) state.siteId = payload.id
  if (payload.revision) state.revision = payload.revision
  if (payload.site && !state.treeDirty) state.tree = payload.site
  state.problems = payload.problems ?? []
  state.stale = false
}

function markStale() {
  state.stale = true
  state.notice = { kind: 'error', text: '磁盘内容已被外部改动（Agent 或手工编辑）。重载后才能保存。' }
  updateStatus()
}

function markTreeDirty() {
  state.treeDirty = true
  updateStatus()
}

function notice(text, kind = 'info') {
  state.notice = { kind, text }
}

/** 当前挂载的块式编辑器（doc 页才有）。重绘时尽量复用它，不重建。 */
let docEditor = null

/** 一棵子树里的全部页面（含它自己），前序。 */
const subtree = (page) => [page, ...(page.children ?? []).flatMap(subtree)]

/**
 * 在整棵树里找一页，连同它所在的那个数组、所属 module、上级与深度。
 * 删除、搬家、以及「选中还在不在」都要从这里问，所以不能只返回 page 本身。
 */
function locatePage(id) {
  const walk = (list, module, parent, depth) => {
    for (let index = 0; index < list.length; index += 1) {
      const page = list[index]
      if (page.id === id) return { page, list, index, module, parent, depth }
      const deeper = walk(page.children ?? [], module, page, depth + 1)
      if (deeper) return deeper
    }
    return null
  }
  for (const mod of state.tree?.modules ?? []) {
    const found = walk(mod.pages ?? [], mod, null, 1)
    if (found) return found
  }
  return null
}

const findPage = (id) => (id ? locatePage(id)?.page ?? null : null)

const selectedPage = () => {
  if (!state.selected || !state.tree) return null
  const found = locatePage(state.selected.id)
  return found ? { ...found.page, module: found.module } : null
}

/** 这棵树里还有没有这一页 —— 删模块/删页之后用来决定要不要清掉选中。 */
const treeHasPage = (tree, id) => (tree?.modules ?? [])
  .some((mod) => (mod.pages ?? []).flatMap(subtree).some((page) => page.id === id))

/* ---------- 渲染 ---------- */

const app = document.getElementById('app')
const barNode = h('header', { class: 'bar' })
const treeNode = h('aside', { class: 'side' })
const mainNode = h('main', { class: 'main' })
const modalNode = h('div', { id: 'modal' })

clear(app, h('div', { class: 'shell' },
  barNode,
  h('div', { class: 'body' }, treeNode, mainNode),
), modalNode)

function render() {
  if (!state.tree) return
  renderBar()
  renderTree()
  renderMain()
}

/** 顶部工具栏：站点信息在左，工作区级的动作全在右。 */
function renderBar() {
  clear(barNode,
    h('div', { class: 'bar-brand' },
      h('img', { class: 'brand-logo', src: '/icon.svg', alt: '', width: 18, height: 18 }),
      h('strong', { text: 'kebab' }),
      h('span', { class: 'dim', text: '编辑器' }),
    ),
    inlineField('站点标题', state.tree.site?.title ?? '', '未命名站点', (value) => {
      state.tree.site = { ...(state.tree.site ?? {}), title: value }
      markTreeDirty()
    }),
    inlineField('副标题', state.tree.site?.subtitle ?? '', '可选', (value) => {
      const head = { ...(state.tree.site ?? {}) }
      if (value) head.subtitle = value
      else delete head.subtitle
      state.tree.site = head
      markTreeDirty()
    }),
    h('div', { class: 'bar-right' },
      h('span', { id: 'notice' }),
      h('span', { id: 'status' }),
      barButton({ id: 'new-module', icon: '＋', label: '模块', title: '新建模块', onclick: openCreateModule }),
      h('button', {
        id: 'problems-btn',
        class: 'bar-btn',
        type: 'button',
        title: '核对清单与磁盘',
        onclick: () => openProblems(),
      },
      h('span', { class: 'bar-icon', text: '✓' }),
      h('span', { text: '核对' }),
      h('span', { class: 'badge', id: 'problems-count', text: '0' })),
      barButton({ id: 'build', icon: '▶', label: '构建', title: '把当前站点的内容构建成 sites/<id>/dist/', onclick: () => runBuild() }),
      barButton({ id: 'reload', icon: '⟳', label: '重载', title: '丢掉内存状态，重新读一遍磁盘', onclick: reload }),
      h('button', { id: 'save', text: '保存', title: '保存（Ctrl+S）', onclick: saveAll }),
    ),
  )
  updateStatus()
  updateProblemsBadge()
  updateTitle()
}

function barButton({ id, icon, label, title, onclick }) {
  return h('button', { id, class: 'bar-btn', type: 'button', title, onclick },
    h('span', { class: 'bar-icon', text: icon }),
    h('span', { text: label }),
  )
}

/** 核对角标：有悬空/孤儿/重复时变红，数字是问题条数。 */
function updateProblemsBadge() {
  const badge = document.getElementById('problems-count')
  const button = document.getElementById('problems-btn')
  if (!badge || !button) return
  const count = state.problems.length
  badge.textContent = String(count)
  badge.classList.toggle('zero', count === 0)
  button.classList.toggle('alert', count > 0)
}

function updateStatus() {
  const status = document.getElementById('status')
  const noticeNode = document.getElementById('notice')
  if (!status || !noticeNode) return

  const dirty = state.treeDirty || state.doc.dirty
  status.className = state.stale ? 'status stale' : dirty ? 'status dirty' : 'status'
  status.textContent = state.stale ? '陈旧' : dirty ? '有未保存的改动' : '已同步'

  noticeNode.className = state.notice ? `notice ${state.notice.kind}` : 'notice'
  noticeNode.textContent = state.notice?.text ?? ''

  const save = document.getElementById('save')
  const reload = document.getElementById('reload')
  if (save) save.disabled = state.stale || !dirty
  if (reload) reload.disabled = false
}

/** 标签页标题：「站点名 - Kebab 编辑器」。站点标题被双击改掉时也跟着变。 */
function updateTitle() {
  const name = state.tree?.site?.title?.trim()
  document.title = `${name || state.siteId || 'kebab'} - Kebab 编辑器`
}

function renderTree() {
  const modules = state.tree.modules ?? []
  clear(treeNode,
    h('div', { class: 'side-head' },
      h('span', { text: '导航树' }),
      h('span', { class: 'dim', text: `${modules.length} 个模块` })),
    modules.length === 0
      ? h('p', { class: 'hint', text: '还没有模块。用顶部工具栏的「模块」建一个，再往里面加页面。' })
      : h('ul', { class: 'modules' }, ...modules.map((mod, index) => moduleNode(mod, index))),
  )
}

/** 只点亮当前页那一行，不重建整棵树 —— 双击改名时要靠这一点保住刚出现的输入框。 */
function markCurrent() {
  for (const node of treeNode.querySelectorAll('.page')) {
    node.classList.toggle('current', node.dataset.pageId === state.selected?.id)
  }
}

function moduleNode(mod, index) {
  const title = nodeTitle(mod.title ?? '', (value) => {
    mod.title = value
    markTreeDirty()
  })
  return h('li', { class: 'module', ...dropTarget({
    kind: 'page',
    // 整块 module 也是 page 的落点：放进这个 module 的根级末尾（不是谁的子级）。
    // 空 module 没有行可落，以及「把下级拖回顶层」，都靠这一条。
    zone: 'into',
    accepts: () => locatePage(dragContext?.id) !== null,
    place: () => rootSpot(mod),
    move: (spot) => movePage(dragContext?.id, spot),
  }) },
    h('div', { class: 'module-head', ...dropTarget({
      kind: 'module',
      // module 之间只有前后，没有上下级
      zone: 'halves',
      index,
      accepts: () => (state.tree.modules ?? []).some((entry) => entry.id === dragContext?.id),
      place: (where) => ({
        mark: where,
        list: state.tree.modules,
        gap: where === 'before' ? index : index + 1,
        from: (state.tree.modules ?? []).findIndex((entry) => entry.id === dragContext?.id),
      }),
      move: (spot) => moveToGap(spot.list, spot.from, spot.gap),
      noop: (spot) => spot.from >= 0 && (spot.gap === spot.from || spot.gap === spot.from + 1),
    }) },
      h('span', { class: 'grip', title: '拖动排序', text: '⠿', ...dragHandle('module', mod.id) }),
      title,
      moreButton((anchor) => openMenu(anchor, [
        { label: '新建 doc 页', onpick: () => openCreatePage(mod.id, 'doc') },
        { label: '新建 proto 页', onpick: () => openCreatePage(mod.id, 'proto') },
        { label: '重命名', onpick: () => startInlineEdit(title, (value) => { mod.title = value; markTreeDirty() }) },
        { label: '删除模块', danger: true, onpick: () => openDeleteModule(mod) },
      ])),
    ),
    h('ul', { class: 'pages' }, ...pageRows(mod, mod.pages ?? [], null, 1)),
  )
}

/** 一个列表里的页面行，连同它们的下级 —— 递归下去。 */
function pageRows(mod, list, parent, depth) {
  return list.map((page, index) => pageNode({ mod, page, list, parent, index, depth }))
}

/**
 * 一页 = 外层 li 包着「行」和「下级列表」。
 * 行和下级是兄弟而不是父子，这样行的 rect 只覆盖它自己 —— 拖拽落点按行高算比例才对。
 */
function pageNode({ mod, page, list, parent, index, depth }) {
  const current = state.selected?.id === page.id
  const rename = (value) => {
    page.title = value
    markTreeDirty()
  }
  const title = nodeTitle(page.title ?? '', rename, page.id)
  const row = h('div', {
    class: `page${current ? ' current' : ''}`,
    'data-page-id': page.id,
    style: `--depth: ${depth}`,
    ...dropTarget({
      kind: 'page',
      // 上三分之一 = 同级插在它前面，中间 = 变成它的下级，下三分之一 = 同级插在它后面
      zone: 'thirds',
      index,
      accepts: () => locatePage(dragContext?.id) !== null,
      place: (where) => pageSpot({ page, list, parent, index, where }),
      move: (spot) => movePage(dragContext?.id, spot),
      noop: (spot) => isNoopSpot(dragContext?.id, spot),
    }),
    onclick: (event) => {
      if (event.target.closest('input, button')) return
      select(page)
    },
  },
    h('span', { class: 'grip', title: '拖动排序', text: '⠿', ...dragHandle('page', page.id) }),
    title,
    h('span', { class: 'type', text: page.type }),
    moreButton((anchor) => openMenu(anchor, [
      { label: '新建下级页面', onpick: () => openCreatePage(mod.id, 'doc', page.id) },
      { label: '重命名', onpick: () => startInlineEdit(title, rename) },
      { label: '删除页面', danger: true, onpick: () => openDeletePage(mod, page) },
    ])),
  )

  const children = page.children ?? []
  if (children.length === 0) return h('li', { class: 'page-item' }, row)
  return h('li', { class: 'page-item' },
    row,
    h('ul', { class: 'pages' }, ...pageRows(mod, children, page, depth + 1)),
  )
}

function renderMain() {
  const page = selectedPage()
  if (!page) {
    teardownDocEditor()
    clear(mainNode, h('div', { class: 'placeholder' },
      h('p', { text: '从左侧选一个页面。' }),
      h('p', { class: 'dim', text: 'doc 页在这里改正文；proto 页在这里预览原型。' })))
    return
  }

  if (page.type === 'proto') {
    teardownDocEditor()
    const entry = page.entry ?? 'index.html'
    const src = `/proto/${page.id}/${entry}`
    clear(mainNode, h('div', { class: 'pane' },
      h('div', { class: 'pane-head' },
        h('strong', { text: page.title }),
        h('span', { class: 'dim', text: `prototypes/${page.id}/` }),
        h('a', { class: 'ghost', href: src, target: '_blank', rel: 'noopener', text: '全屏打开' })),
      h('iframe', { class: 'proto-frame', src, title: page.title }),
    ))
    return
  }

  // 编辑器是重量级对象，重绘时不重建它，只更新头部那几处文字
  if (docEditor && docEditor.pageId === page.id && docEditor.host.isConnected) {
    docEditor.head.replaceChildren(
      h('strong', { text: page.title }),
      h('span', { class: 'dim', text: `pages/${page.id}.md` }),
      h('span', { class: 'dim', text: '正文从 ## 开始，编号渲染时自动算' }),
    )
    return
  }

  teardownDocEditor()
  const host = h('div', { class: 'doc-host' })
  const head = h('div', { class: 'pane-head' })
  clear(mainNode, h('div', { class: 'pane' }, head, host))
  mountEditor(page, host, head)
}

/** 挂载块式编辑器。切换页面与重绘都只发生在挂载前后，编辑中不重建。 */
async function mountEditor(page, host, head) {
  docEditor = { pageId: page.id, host, head, handle: null }
  const handle = await mountDocEditor({
    root: host,
    markdown: state.doc.text ?? '',
    onUpload: uploadImage,
    onChange: (markdown) => {
      // 挂载完成后 Crepe 必定补报一次序列化结果，它与刚读进来的正文只差末尾空行。
      // 没真改就不算改动，否则一打开页面就提示「有未保存的改动」，而保存写回去还是一样的字节
      if (!isRealChange(state.doc.text, markdown)) return
      state.doc.text = markdown
      state.doc.dirty = true
      updateStatus()
    },
  })
  if (!host.isConnected) {
    // 挂载期间用户已经切走了
    await handle.destroy()
    return
  }
  docEditor.handle = handle
  renderMain()
}

function teardownDocEditor() {
  if (!docEditor) return
  docEditor.handle?.destroy?.()
  docEditor = null
}

/** 取编辑器里的 Markdown。万一取不到就退回内存副本 —— 宁可保存旧一点，也别丢改动。 */
function readEditorMarkdown() {
  try {
    return docEditor?.handle?.getMarkdown() ?? state.doc.text
  } catch (error) {
    console.warn('[kebab] 从编辑器取 Markdown 失败，改用内存副本：', error)
    return state.doc.text
  }
}

/** 截图等图片经这里落进 assets/，返回正文里该写的相对路径。 */
async function uploadImage(file) {
  const query = new URLSearchParams({ name: file.name || 'paste.png', baseRevision: state.revision })
  const response = await fetch(`/api/asset/upload?${query}`, { method: 'POST', body: file })
  const payload = await response.json().catch(() => ({}))
  if (response.status === 409) {
    markStale()
    throw new Error('磁盘内容已被外部改动，请先重载')
  }
  if (!response.ok) throw new Error(payload.error ?? `上传失败（HTTP ${response.status}）`)
  state.revision = payload.revision
  state.problems = payload.problems ?? state.problems
  updateProblemsBadge()
  return payload.path
}

/** 核对结果不再常驻底部，改由顶部「核对」图标（带角标）弹出。 */
function openProblems() {
  const groups = { duplicate: [], dangling: [], orphan: [], 'unused-asset': [] }
  for (const problem of state.problems) (groups[problem.kind] ?? (groups[problem.kind] = [])).push(problem)

  const rows = []
  for (const problem of groups.duplicate) rows.push(problemRow('重复', 'duplicate', problem.message))
  for (const problem of groups.dangling) rows.push(problemRow('悬空', 'dangling', problem.message))
  for (const problem of groups.orphan) {
    const path = problem.path
    rows.push(h('li', { class: 'problem orphan' },
      h('span', { class: 'tag', text: '孤儿' }),
      h('span', { class: 'problem-text', text: problem.message }),
      moreButton((anchor) => openMenu(anchor, [
        { label: '导入为页面', onpick: () => { closeModal(); openImportOrphan(path) } },
        { label: '删除文件', danger: true, onpick: () => { closeModal(); openDeleteOrphan(path) } },
      ])),
    ))
  }
  for (const problem of groups['unused-asset']) {
    const path = problem.path
    rows.push(h('li', { class: 'problem unused' },
      h('span', { class: 'tag', text: '闲置' }),
      h('span', { class: 'problem-text', text: problem.message }),
      moreButton((anchor) => openMenu(anchor, [
        { label: '删除文件', danger: true, onpick: () => { closeModal(); openDeleteUnusedAsset(path) } },
      ])),
    ))
  }

  openPanel('核对', rows.length === 0
    ? [h('p', { class: 'dim', text: '清单与磁盘一致：没有悬空引用、孤儿文件、闲置素材或重复编号。' })]
    : [
      h('p', { class: 'dim', text: `${state.problems.length} 个问题。行尾的「⋯」是它自己的出口。` }),
      h('ul', { class: 'problems' }, ...rows),
    ])
}

const problemRow = (tag, kind, message) => h('li', { class: `problem ${kind}` },
  h('span', { class: 'tag', text: tag }),
  h('span', { class: 'problem-text', text: message }),
)

/* ---------- 行内编辑与「⋯」菜单 ---------- */

/** 顶栏的站点字段：平时是一行只读文字，双击才改。 */
function inlineField(label, value, placeholder, commit) {
  const span = h('span', {
    class: `field-value${value ? '' : ' empty'}`,
    title: '双击修改',
    text: value || placeholder,
  })
  span.addEventListener('dblclick', () => startInlineEdit(span, commit))
  return h('label', { class: 'field-inline' },
    h('span', { class: 'field-label', text: label }),
    span,
  )
}

/** 树节点标题：静态文本，双击就地改名。 */
function nodeTitle(value, commit, pageId = null) {
  const span = h('span', { class: 'node-title', title: '双击修改', text: value })
  span.addEventListener('dblclick', (event) => {
    event.stopPropagation()
    // 双击一个还没选中的页面时顺带选中它。选中只重绘右栏，不会把这里刚出现的输入框冲掉。
    if (pageId && state.selected?.id !== pageId) {
      const page = findPage(pageId)
      if (page) select(page)
    }
    startInlineEdit(span, commit)
  })
  return span
}

/** 双击后的就地编辑：Enter 或失焦提交，Esc 取消；空值当成没改。 */
function startInlineEdit(span, commit) {
  const original = span.classList.contains('empty') ? '' : span.textContent
  const input = h('input', { class: 'inline-edit', value: original })
  span.replaceWith(input)
  input.focus()
  input.select()

  let done = false
  const finish = (save) => {
    if (done) return
    done = true
    const next = input.value.trim()
    input.replaceWith(span)
    if (!save || !next || next === original) return
    span.textContent = next
    span.classList.remove('empty')
    commit(next)
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      finish(false)
    }
  })
  input.addEventListener('blur', () => finish(true))
  input.addEventListener('click', (event) => event.stopPropagation())
  input.addEventListener('dblclick', (event) => event.stopPropagation())
}

/** 行尾的「⋯」：一行只留一个图标，操作都收进弹出的菜单里。 */
function moreButton(build) {
  return h('button', {
    type: 'button',
    class: 'more',
    title: '更多操作',
    text: '⋯',
    onclick: (event) => {
      event.stopPropagation()
      const anchor = event.currentTarget
      if (anchor.classList.contains('active')) return closeMenu()
      closeMenu()
      anchor.classList.add('active')
      build(anchor)
    },
  })
}

let menuNode = null

function closeMenu() {
  if (!menuNode) return
  menuNode.remove()
  menuNode = null
  for (const node of document.querySelectorAll('.more.active')) node.classList.remove('active')
}

/** 弹出的操作菜单：贴着锚点下沿，点别处、滚动或 Esc 都收起来。 */
function openMenu(anchor, items) {
  closeMenu()
  const menu = h('div', { class: 'menu', role: 'menu' },
    ...items.map((item) => h('button', {
      type: 'button',
      class: `menu-item${item.danger ? ' danger' : ''}`,
      role: 'menuitem',
      onclick: (event) => {
        event.stopPropagation()
        closeMenu()
        item.onpick()
      },
    }, item.label)))
  menu.addEventListener('click', (event) => event.stopPropagation())
  document.body.append(menu)

  const rect = anchor.getBoundingClientRect()
  const width = menu.offsetWidth
  menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`
  menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`
  menuNode = menu
  return menu
}

document.addEventListener('click', () => closeMenu())
window.addEventListener('resize', () => closeMenu())
document.addEventListener('scroll', () => closeMenu(), true)

/* ---------- 拖拽排序 ---------- */

/**
 * 拖拽：只有行首的握把是拖拽起点，整行是落点。page 行分三段 ——
 * 上三分之一插到它前面（同级），中间三分之一变成它的下级，下三分之一插到它后面（同级）；
 * module 行只分前后两段（module 之间没有上下级）；整块 module 是固定落点，放根级末尾。
 *
 * 几个坑记在这儿，都是踩过的：握把嵌在行里，dragstart 会冒到外层那行，外层若是同一个
 * handler 就会把 page 的上下文盖成 module；把「被拖那一项原来在第几位」当落点，落点跟
 * 起点永远相等，等于空操作；还有一行连着它的下级时，行的 rect 会把下级也算进去，
 * 按行高算比例就错位 —— 所以行与下级列表是兄弟，不是父子。
 */
let dragContext = null // { kind: 'module' | 'page', id }
let dropMark = null // { node, where: 'before' | 'after' | 'into' }

/** 握把：拖拽起点。只有它可拖 —— 整行可拖会跟双击改名、正文选择抢鼠标。 */
function dragHandle(kind, id) {
  return {
    draggable: 'true',
    ondragstart: (event) => {
      dragContext = { kind, id }
      event.stopPropagation()
      event.dataTransfer.effectAllowed = 'move'
      // Firefox 不往 dataTransfer 里放点东西就不肯开始拖
      event.dataTransfer.setData('text/plain', id)
      rowOf(event.currentTarget)?.classList.add('dragging')
    },
    ondragend: (event) => {
      rowOf(event.currentTarget)?.classList.remove('dragging')
      clearDropMark()
      dragContext = null
    },
  }
}

/** 握把所在的那一行：page 就是它自己那一行，module 的握把在 module-head 里。 */
const rowOf = (grip) => grip.closest('.page, .module')

function markDrop(node, where) {
  if (dropMark?.node === node && dropMark.where === where) return
  clearDropMark()
  node.classList.add(where === 'into' ? 'drop-into' : `drop-${where}`)
  dropMark = { node, where }
}

function clearDropMark() {
  if (!dropMark) return
  dropMark.node.classList.remove('drop-before', 'drop-after', 'drop-into')
  dropMark = null
}

/**
 * 指针落在行的哪一段。用 currentTarget 而不是另传节点：事件冒泡到谁，量的就是谁。
 * jsdom 不做排版，测试里得给行喂一个 getBoundingClientRect。
 */
function zoneAt(node, clientY, mode) {
  if (mode === 'into') return 'into'
  const rect = node.getBoundingClientRect()
  const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5
  if (mode === 'halves') return ratio < 0.5 ? 'before' : 'after'
  if (ratio < 1 / 3) return 'before'
  return ratio > 2 / 3 ? 'after' : 'into'
}

/**
 * 一行的落点行为：
 * - `accepts()`：这一行接不接
 * - `place(where)`：算出「被拖的那一项要插到哪儿」，只读不写
 * - `noop(spot)`：这个落点是不是等于「放回原处」（是就不画标记）
 * - `move(spot)`：真正搬家
 */
function dropTarget({ kind, zone, index, accepts, place, move, noop }) {
  const isNoop = noop ?? (() => false)
  return {
    ondragover: (event) => {
      if (dragContext?.kind !== kind) return
      if (!accepts()) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      const spot = place(zoneAt(event.currentTarget, event.clientY, zone))
      if (spot && !isNoop(spot)) markDrop(event.currentTarget, spot.mark)
      else clearDropMark()
    },
    ondrop: (event) => {
      if (dragContext?.kind !== kind) return // 不是自己这一类，交给外层那一行处置
      if (!accepts()) return
      event.preventDefault()
      event.stopPropagation()
      clearDropMark()
      const spot = place(zoneAt(event.currentTarget, event.clientY, zone))
      if (spot && !isNoop(spot) && move(spot)) {
        markTreeDirty()
        renderTree()
      }
    },
  }
}

/**
 * 把第 from 项挪到第 gap 个空档（gap = n 表示挪到第 n 项之前）。
 * 先摘掉再插回，所以落点在自己身后时要往前收一格 —— 不收就会多走一位。
 */
function moveToGap(list, from, gap) {
  if (!list || from < 0 || from >= list.length) return false
  const at = gap > from ? gap - 1 : gap
  if (at === from || at < 0 || at >= list.length) return false
  const [moved] = list.splice(from, 1)
  list.splice(at, 0, moved)
  return true
}

/** 被拖的那页是不是 target 自己或它的祖先 —— 不能把一页拖进它自己的后代里。 */
function isSelfOrAncestor(page, id) {
  return page.id === id || (page.children ?? []).some((child) => isSelfOrAncestor(child, id))
}

/** 拖到某一页的中间三分之一：变成它的下级，排在已有下级的末尾。 */
const childSpot = (parent) => ({ mark: 'into', parent })

/** 拖到某一页的上/下沿：插到它前面或后面，跟它同级（同级列表可能是 module 根级，也可能是某一页的下级）。 */
const siblingSpot = (list, index, where) => ({ mark: where, list, gap: where === 'before' ? index : index + 1 })

/** 拖到 module 的空白处：放进这个 module 的根级末尾。 */
const rootSpot = (mod) => ({ mark: 'into', list: mod.pages ?? [], gap: (mod.pages ?? []).length })

/** 一页行的落点：三段各对应「同级前 / 下级 / 同级后」。 */
function pageSpot({ page, list, index, where }) {
  if (where === 'into') return childSpot(page)
  return siblingSpot(list, index, where)
}

/** 这个落点是不是「放回原处」——是的话别画标记，也别标脏。 */
function isNoopSpot(id, spot) {
  const found = locatePage(id)
  if (!found) return true
  if (spot.parent) {
    if (isSelfOrAncestor(found.page, spot.parent.id)) return true
    const children = spot.parent.children ?? []
    // 已经是它的最后一个下级：拖了等于没拖
    return found.list === spot.parent.children && found.index === children.length - 1
  }
  if (found.list !== spot.list) {
    // 换列表：只有「拖进自己的后代」才是空操作，上面已经挡掉了
    return false
  }
  return spot.gap === found.index || spot.gap === found.index + 1
}

/**
 * 把一页搬到 spot 指定的位置，连同它的整棵子树一起。
 * 正文位置由 page id 推出、与层级无关，所以搬家只改 site.json，磁盘上一个文件都不动。
 */
function movePage(id, spot) {
  const found = locatePage(id)
  if (!found) return false
  if (isNoopSpot(id, spot)) return false

  if (spot.parent) {
    const children = (spot.parent.children ??= [])
    found.list.splice(found.index, 1)
    children.push(found.page)
    return true
  }
  if (found.list === spot.list) return moveToGap(spot.list, found.index, spot.gap)
  found.list.splice(found.index, 1)
  spot.list.splice(spot.gap, 0, found.page)
  return true
}

/* ---------- 弹层 ---------- */

/** 只展示不提交的弹层：构建结果这类东西用得上。 */
function openPanel(title, nodes, actions = []) {
  modalNode.replaceChildren(h('div', {
    class: 'modal-backdrop',
    onclick: (event) => {
      if (event.target === event.currentTarget) closeModal()
    },
  },
    h('div', { class: 'modal-box' },
      h('h2', { text: title }),
      ...nodes,
      h('div', { class: 'modal-actions' },
        ...actions,
        h('button', { type: 'button', class: 'ghost', text: '关闭', onclick: closeModal }),
      ),
    ),
  ))
}

/** 构建当前站点：走的是与 npm run build 同一条代码路径。 */
async function runBuild(force = false) {
  const hasUnsaved = [state.treeDirty, state.doc.dirty].some(Boolean)
  if (hasUnsaved) {
    if (!window.confirm('有还没保存的改动。先保存再构建？')) return
    await saveAll()
    if ([state.treeDirty, state.doc.dirty].some(Boolean)) return
  }

  state.notice = null
  try {
    openBuildReport(await api.build(force))
  } catch (error) {
    notice(error.message, 'error')
    render()
  }
}

function openBuildReport(result) {
  const nodes = []

  if (result.ok) {
    nodes.push(h('p', { text: `${result.id} 构建完成：${result.pages} 个页面 + 概览页` }))
    nodes.push(h('p', { class: 'dim', text: `${result.dist}/` }))
    nodes.push(h('p', {}, h('a', { href: '/build/index.html', target: '_blank', rel: 'noopener', text: '打开产物里的概览页' })))
    if (result.forced) {
      nodes.push(h('p', { class: 'dim', text: '是按「强制构建」放行的，下面这些问题并没有修。' }))
    } else if (result.problems?.length) {
      nodes.push(h('p', { class: 'dim', text: '下面这些只是提示，没有拦住构建。' }))
    }
  } else {
    nodes.push(h('p', {
      text: result.stage === 'doctor'
        ? '清单与磁盘不一致，没有构建。'
        : '原型导入校验没过，没有构建。',
    }))
  }

  if (result.problems?.length) {
    nodes.push(h('ul', { class: 'problems' }, ...result.problems.map((problem) => h('li', { class: 'problem' },
      h('span', { class: 'tag', text: problem.kind }),
      h('span', { text: problem.message }),
      problem.hint ? h('span', { class: 'dim', text: `→ ${problem.hint}` }) : null,
    ))))
  }

  const actions = result.ok ? [] : [
    h('button', {
      type: 'button',
      class: 'danger',
      text: '强制构建',
      onclick: () => {
        closeModal()
        runBuild(true)
      },
    }),
  ]

  openPanel('构建结果', nodes, actions)
}

function closeModal() {
  modalNode.replaceChildren()
}

function openModal({ title, fields = [], checkbox, submitLabel = '确定', danger = false }, onSubmit) {
  const inputs = {}
  const errorLine = h('p', { class: 'modal-error' })

  const fieldNodes = fields.map((field) => {
    const node = field.type === 'select'
      ? h('select', {}, ...field.options.map((option) => h('option', { value: option.value }, option.label)))
      : h('input', { type: 'text', value: field.value ?? '', placeholder: field.placeholder ?? '' })
    if (field.type === 'select') node.value = field.value
    inputs[field.name] = node
    return h('label', { class: 'modal-field' }, h('span', { text: field.label }), node)
  })

  let checkboxNode = null
  if (checkbox) {
    checkboxNode = h('input', { type: 'checkbox' })
    checkboxNode.checked = Boolean(checkbox.checked)
    fieldNodes.push(h('label', { class: 'modal-field modal-check' },
      checkboxNode, h('span', { text: checkbox.label })))
  }

  const form = h('form', {
    class: 'modal-box',
    onsubmit: async (event) => {
      event.preventDefault()
      const values = Object.fromEntries(Object.entries(inputs).map(([name, node]) => [name, node.value]))
      values.withFiles = checkboxNode ? checkboxNode.checked : false
      try {
        await onSubmit(values)
        closeModal()
        render()
      } catch (error) {
        errorLine.textContent = error.message
      }
    },
  },
    h('h2', { text: title }),
    ...fieldNodes,
    errorLine,
    h('div', { class: 'modal-actions' },
      h('button', { type: 'button', class: 'ghost', text: '取消', onclick: closeModal }),
      h('button', { type: 'submit', class: danger ? 'danger' : '', text: submitLabel }),
    ),
  )

  modalNode.replaceChildren(h('div', { class: 'modal-backdrop', onclick: (event) => {
    if (event.target === event.currentTarget) closeModal()
  } }, form))
  const first = form.querySelector('input, select')
  if (first) first.focus()
}

/* ---------- 动作 ---------- */

const run = async (action) => {
  state.notice = null
  try {
    const payload = await action()
    if (payload) applyState(payload)
  } catch (error) {
    notice(error.message, 'error')
  }
  render()
}

async function select(page) {
  if (state.selected?.id === page.id && (page.type === 'proto' || state.doc.id === page.id)) {
    // 已经在这一页：不重来一遍。重复拉取正文会丢掉没保存的改动，
    // 重绘导航树则会冲掉正在双击改名的那一行。
    return
  }
  if (state.doc.dirty && state.doc.id !== page.id) {
    if (!window.confirm('正文有未保存的改动，切过去会丢掉，继续？')) return
  }
  state.selected = { id: page.id, type: page.type }
  state.doc = { id: null, text: '', dirty: false }
  if (page.type === 'doc') {
    try {
      const payload = await api.doc(page.id)
      state.doc = { id: page.id, text: payload.text ?? '', dirty: false }
      if (payload.revision) state.revision = payload.revision
      state.notice = payload.text === null
        ? { kind: 'error', text: `pages/${page.id}.md 不存在，保存一次就会创建它。` }
        : null
    } catch (error) {
      notice(error.message, 'error')
    }
  }
  renderMain()
  markCurrent()
  updateStatus()
}

const saveAll = () => run(async () => {
  let rescued = 0
  let stripped = 0
  if (state.treeDirty) {
    const payload = await api.saveTree(state.tree)
    state.treeDirty = false
    applyState(payload)
  }
  if (state.doc.dirty && state.doc.id) {
    const payload = await api.saveDoc(state.doc.id, readEditorMarkdown())
    state.doc.dirty = false
    applyState(payload)
    rescued = payload.rescued ?? 0
    stripped = payload.stripped ?? 0
    if (rescued > 0 || stripped > 0) {
      // 落盘时正文被改写过（内联图片搬进了 assets/，空段落留下的 <br /> 被抹掉），
      // 内存里还是改写前的版本 —— 换成落盘的那一份，免得下次保存又写回去
      const fresh = await api.doc(state.doc.id)
      state.doc.text = fresh.text ?? ''
      docEditor?.handle?.setMarkdown(state.doc.text)
    } else {
      state.doc.text = readEditorMarkdown()
    }
  }

  const notes = []
  if (rescued > 0) notes.push(`把 ${rescued} 张内联图片搬进了 assets/`)
  if (stripped > 0) notes.push(`抹掉了 ${stripped} 处空行`)
  notice(notes.length > 0 ? `已保存（${notes.join('；')}）` : '已保存')
  return null
})

const reload = () => run(async () => {
  if ((state.treeDirty || state.doc.dirty) && !window.confirm('有未保存的改动，重载会丢掉，继续？')) return null
  state.treeDirty = false
  state.doc = { id: null, text: '', dirty: false }
  state.selected = null
  state.notice = null
  const payload = await api.state()
  applyState(payload)
  return null
})

function openCreateModule() {
  openModal({
    title: '新建模块',
    fields: [
      { name: 'moduleId', label: 'module id', placeholder: '如 order，用作标识' },
      { name: 'title', label: '模块标题', placeholder: '如 订单管理' },
    ],
    submitLabel: '创建',
  }, (values) => api.createModule(values).then(applyState))
}

function openCreatePage(moduleId, type = 'doc', parentId = null) {
  const parent = parentId ? findPage(parentId) : null
  openModal({
    title: parent ? `在「${parent.title ?? parent.id}」下新建页面` : '新建页面',
    fields: [
      { name: 'type', label: '类型', type: 'select', value: type, options: [
        { value: 'doc', label: 'doc —— Markdown 正文' },
        { value: 'proto', label: 'proto —— 原型目录' },
      ] },
      { name: 'pageId', label: 'page id', placeholder: '如 order-revamp，决定文件位置' },
      { name: 'title', label: '页面标题', placeholder: '留空则用 page id' },
    ],
    submitLabel: '创建',
  }, (values) => api.createPage({ ...values, moduleId, parentId }).then(applyState))
}

function openDeletePage(mod, page) {
  const doomed = subtree(page)
  const nested = doomed.length - 1
  openModal({
    title: nested > 0
      ? `删除 ${page.title ?? page.id}（连同 ${nested} 个下级页面）`
      : `删除 ${page.title ?? page.id}`,
    checkbox: {
      label: nested > 0
        ? `同时删掉磁盘上这 ${doomed.length} 个页面的文件`
        : '同时删掉磁盘上的正文文件',
      checked: false,
    },
    submitLabel: '删除',
    danger: true,
  }, (values) => api.deletePage(page.id, values.withFiles).then((payload) => {
    // 选中的那一页要是在被删的子树里，一并清掉
    const gone = new Set(doomed.map((entry) => entry.id))
    if (state.selected && gone.has(state.selected.id)) {
      state.selected = null
      state.doc = { id: null, text: '', dirty: false }
    }
    applyState(payload)
  }))
}

function openDeleteModule(mod) {
  const count = (mod.pages ?? []).flatMap(subtree).length
  openModal({
    title: `删除模块 ${mod.title ?? mod.id}`,
    checkbox: { label: `同时删掉它下面 ${count} 个页面的文件`, checked: false },
    submitLabel: '删除',
    danger: true,
  }, (values) => api.deleteModule(mod.id, values.withFiles).then((payload) => {
    if (state.selected && !treeHasPage(payload.site, state.selected.id)) {
      state.selected = null
      state.doc = { id: null, text: '', dirty: false }
    }
    applyState(payload)
  }))
}

function openImportOrphan(path) {
  const modules = state.tree.modules ?? []
  if (modules.length === 0) {
    notice('先建一个模块，孤儿文件才有地方安放。', 'error')
    render()
    return
  }
  const suggestion = path.startsWith('prototypes/')
    ? path.slice('prototypes/'.length)
    : path.slice('pages/'.length).replace(/\.[^.]+$/, '')

  openModal({
    title: `导入 ${path}`,
    fields: [
      { name: 'moduleId', label: '放进哪个模块', type: 'select', value: modules[0].id,
        options: modules.map((mod) => ({ value: mod.id, label: mod.title ?? mod.id })) },
      { name: 'title', label: '页面标题', value: suggestion },
    ],
    submitLabel: '导入',
  }, (values) => api.importOrphan({ ...values, path }).then(applyState))
}

function openDeleteOrphan(path) {
  openModal({
    title: `删除 ${path}`,
    fields: [],
    submitLabel: '删除文件',
    danger: true,
  }, () => api.deleteOrphan(path).then(applyState))
}

/** 闲置素材：删之前服务端会照磁盘当下的正文再核一遍引用，真要还有人用会拒绝。 */
function openDeleteUnusedAsset(path) {
  openModal({
    title: `删除 ${path}`,
    fields: [],
    submitLabel: '删除文件',
    danger: true,
  }, () => api.deleteUnusedAsset(path).then(applyState))
}

/* ---------- 启动 ---------- */

async function boot() {
  try {
    applyState(await api.state())
  } catch (error) {
    app.textContent = `无法连上编辑器服务：${error.message}`
    return
  }
  if (!state.tree) {
    app.textContent = '服务端没有指定站点，用 npm run edit -- --site <id> 启动。'
    return
  }
  render()
  watch()
}

/** 轮询指纹：外部改动（Agent、手工编辑）一到就标记陈旧并拦下保存，见 docs/adr/0006。 */
function watch() {
  setInterval(async () => {
    try {
      const payload = await api.state()
      if (payload.revision && payload.revision !== state.revision && !state.stale) {
        markStale()
        render()
      }
    } catch {
      /* 服务暂时不可达时静默重试 */
    }
  }, 2000)
}

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault()
    saveAll()
  }
  if (event.key === 'Escape') {
    closeMenu()
    closeModal()
  }
})

boot()
