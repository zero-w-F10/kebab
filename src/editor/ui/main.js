import './style.css'
import { mountDocEditor } from './doc-editor.js'

/**
 * 编辑器前端。刻意用原生 DOM：这一轮的界面只有导航树与一个源码框，
 * 为此引入框架只会让下一步的 Milkdown 多一层要协调的东西。
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
  importOrphan: (payload) => request('POST', '/api/orphan/import', { body: { ...payload, ...base() } }),
  deleteOrphan: (path) => request('POST', '/api/orphan/delete', { body: { path, ...base() } }),
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

const selectedPage = () => {
  if (!state.selected || !state.tree) return null
  for (const mod of state.tree.modules ?? []) {
    const page = (mod.pages ?? []).find((entry) => entry.id === state.selected.id)
    if (page) return { ...page, module: mod }
  }
  return null
}

/* ---------- 渲染 ---------- */

const app = document.getElementById('app')
const barNode = h('header', { class: 'bar' })
const treeNode = h('aside', { class: 'side' })
const mainNode = h('main', { class: 'main' })
const footNode = h('footer', { class: 'foot' })
const modalNode = h('div', { id: 'modal' })

clear(app, h('div', { class: 'shell' },
  barNode,
  h('div', { class: 'body' }, treeNode, mainNode),
  footNode,
), modalNode)

function render() {
  if (!state.tree) return
  renderBar()
  renderTree()
  renderMain()
  renderFoot()
}

function renderBar() {
  clear(barNode,
    h('div', { class: 'bar-brand' },
      h('strong', { text: 'kebab' }),
      h('span', { class: 'dim', text: '编辑器' }),
    ),
    h('label', { class: 'field-inline' },
      h('span', { text: '站点标题' }),
      h('input', {
        id: 'site-title',
        value: state.tree.site?.title ?? '',
        oninput: (event) => {
          state.tree.site = { ...(state.tree.site ?? {}), title: event.target.value }
          markTreeDirty()
        },
      }),
    ),
    h('label', { class: 'field-inline' },
      h('span', { text: '副标题' }),
      h('input', {
        value: state.tree.site?.subtitle ?? '',
        placeholder: '可选',
        oninput: (event) => {
          const subtitle = event.target.value
          const head = { ...(state.tree.site ?? {}) }
          if (subtitle) head.subtitle = subtitle
          else delete head.subtitle
          state.tree.site = head
          markTreeDirty()
        },
      }),
    ),
    h('div', { class: 'bar-right' },
      h('span', { id: 'notice' }),
      h('span', { id: 'status' }),
      h('button', { id: 'reload', class: 'ghost', text: '重载', onclick: reload }),
      h('button', { id: 'save', text: '保存', onclick: saveAll }),
    ),
  )
  updateStatus()
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

function renderTree() {
  const modules = state.tree.modules ?? []
  clear(treeNode,
    h('div', { class: 'side-head' },
      h('span', { text: '导航树' }),
      h('span', { class: 'dim', text: `${modules.length} 个模块` })),
    modules.length === 0
      ? h('p', { class: 'hint', text: '还没有模块。先建一个，再往里面加页面。' })
      : h('ul', { class: 'modules' }, ...modules.map((mod, index) => moduleNode(mod, index))),
    h('div', { class: 'side-foot' },
      h('button', { class: 'ghost', text: '+ 模块', onclick: openCreateModule }),
    ),
  )
}

function moduleNode(mod, index) {
  return h('li', { class: 'module', ...dragHandlers('module', mod.id, index, dropModule) },
    h('div', { class: 'module-head' },
      h('span', { class: 'grip', title: '拖动排序', text: '⠿' }),
      h('span', { class: 'prefix', text: mod.prefix ?? '—' }),
      h('input', {
        class: 'module-title',
        value: mod.title ?? '',
        oninput: (event) => {
          mod.title = event.target.value
          markTreeDirty()
        },
      }),
      h('button', { class: 'ghost', text: '+ 页', onclick: () => openCreatePage(mod.id) }),
      h('button', { class: 'ghost danger', text: '删', title: '删除模块', onclick: () => openDeleteModule(mod) }),
    ),
    h('ul', { class: 'pages' },
      ...(mod.pages ?? []).map((page, pageIndex) => pageNode(mod, page, pageIndex))),
  )
}

function pageNode(mod, page, index) {
  const current = state.selected?.id === page.id
  return h('li', {
    class: `page${current ? ' current' : ''}`,
    ...dragHandlers('page', page.id, index, (event) => dropPage(page, event)),
    onclick: (event) => {
      if (event.target.closest('input, button')) return
      select(page)
    },
  },
    h('span', { class: 'grip', title: '拖动排序', text: '⠿' }),
    h('span', { class: 'code', text: page.code ?? '' }),
    h('input', {
      class: 'page-title',
      value: page.title ?? '',
      oninput: (event) => {
        page.title = event.target.value
        markTreeDirty()
      },
    }),
    h('span', { class: 'type', text: page.type }),
    h('button', { class: 'ghost danger', text: '删', title: '删除页面', onclick: () => openDeletePage(mod, page) }),
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
        h('span', { class: 'code', text: page.code ?? '' }),
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
      h('span', { class: 'code', text: page.code ?? '' }),
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
  renderFoot()
  return payload.path
}

function renderFoot() {
  const groups = { duplicate: [], dangling: [], orphan: [] }
  for (const problem of state.problems) (groups[problem.kind] ?? (groups[problem.kind] = [])).push(problem)

  const rows = []
  for (const problem of groups.duplicate) {
    rows.push(h('li', { class: 'problem duplicate' }, h('span', { class: 'tag', text: '重复' }), problem.message))
  }
  for (const problem of groups.dangling) {
    rows.push(h('li', { class: 'problem dangling' }, h('span', { class: 'tag', text: '悬空' }), problem.message))
  }
  for (const problem of groups.orphan) {
    const path = problem.path
    rows.push(h('li', { class: 'problem orphan' },
      h('span', { class: 'tag', text: '孤儿' }),
      h('span', { text: problem.message }),
      h('button', { class: 'ghost', text: '导入为页面', onclick: () => openImportOrphan(path) }),
      h('button', { class: 'ghost danger', text: '删除文件', onclick: () => openDeleteOrphan(path) }),
    ))
  }

  clear(footNode,
    h('div', { class: 'foot-head' },
      h('span', { text: '核对' }),
      h('span', { class: 'dim', text: rows.length === 0 ? '清单与磁盘一致' : `${state.problems.length} 个问题` })),
    rows.length === 0
      ? h('p', { class: 'hint', text: '没有发现悬空引用、孤儿文件或重复编号。' })
      : h('ul', { class: 'problems' }, ...rows),
  )
}

/* ---------- 拖拽排序 ---------- */

let dragContext = null

function dragHandlers(kind, id, index, onDrop) {
  return {
    draggable: 'true',
    ondragstart: (event) => {
      dragContext = { kind, id, index }
      event.dataTransfer.effectAllowed = 'move'
    },
    ondragover: (event) => {
      if (dragContext?.kind !== kind) return
      event.preventDefault()
      event.currentTarget.classList.add('drop-target')
    },
    ondragleave: (event) => event.currentTarget.classList.remove('drop-target'),
    ondrop: (event) => {
      event.preventDefault()
      event.currentTarget.classList.remove('drop-target')
      onDrop(event)
      dragContext = null
    },
    ondragend: () => {
      dragContext = null
    },
  }
}

const moveWithin = (list, from, to) => {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return false
  const [moved] = list.splice(from, 1)
  list.splice(to, 0, moved)
  return true
}

function dropModule(event) {
  if (dragContext?.kind !== 'module') return
  const modules = state.tree.modules ?? []
  const from = modules.findIndex((mod) => mod.id === dragContext.id)
  if (moveWithin(modules, from, dragContext.index)) {
    markTreeDirty()
    renderTree()
  }
}

/** 只在同一个 module 内重排：code 前缀与模块绑定，跨模块搬运会让编号对不上。 */
function dropPage(page, event) {
  if (dragContext?.kind !== 'page') return
  const mod = (state.tree.modules ?? []).find((entry) => (entry.pages ?? []).includes(page))
  if (!mod) return
  const from = mod.pages.findIndex((entry) => entry.id === dragContext.id)
  if (moveWithin(mod.pages, from, mod.pages.indexOf(page))) {
    markTreeDirty()
    renderTree()
  }
}

/* ---------- 弹层 ---------- */

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
  render()
}

const saveAll = () => run(async () => {
  if (state.treeDirty) {
    const payload = await api.saveTree(state.tree)
    state.treeDirty = false
    applyState(payload)
  }
  if (state.doc.dirty && state.doc.id) {
    const text = readEditorMarkdown()
    const payload = await api.saveDoc(state.doc.id, text)
    state.doc.dirty = false
    state.doc.text = text
    applyState(payload)
  }
  notice('已保存')
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
      { name: 'prefix', label: 'code 前缀', placeholder: '如 OR，用于 OR-01 这样的编号' },
    ],
    submitLabel: '创建',
  }, (values) => api.createModule(values).then(applyState))
}

function openCreatePage(moduleId) {
  openModal({
    title: '新建页面',
    fields: [
      { name: 'type', label: '类型', type: 'select', value: 'doc', options: [
        { value: 'doc', label: 'doc —— Markdown 正文' },
        { value: 'proto', label: 'proto —— 原型目录' },
      ] },
      { name: 'pageId', label: 'page id', placeholder: '如 order-revamp，决定文件位置' },
      { name: 'title', label: '页面标题', placeholder: '留空则用 page id' },
    ],
    submitLabel: '创建',
  }, (values) => api.createPage({ ...values, moduleId }).then(applyState))
}

function openDeletePage(mod, page) {
  openModal({
    title: `删除 ${page.code ?? ''} ${page.title ?? ''}`,
    checkbox: { label: '同时删掉磁盘上的正文文件', checked: false },
    submitLabel: '删除',
    danger: true,
  }, (values) => api.deletePage(page.id, values.withFiles).then((payload) => {
    if (state.selected?.id === page.id) {
      state.selected = null
      state.doc = { id: null, text: '', dirty: false }
    }
    applyState(payload)
  }))
}

function openDeleteModule(mod) {
  const count = (mod.pages ?? []).length
  openModal({
    title: `删除模块 ${mod.title ?? mod.id}`,
    checkbox: { label: `同时删掉它下面 ${count} 个页面的文件`, checked: false },
    submitLabel: '删除',
    danger: true,
  }, (values) => api.deleteModule(mod.id, values.withFiles).then((payload) => {
    if (state.selected && !(payload.site.modules ?? []).some((entry) => (entry.pages ?? []).some((page) => page.id === state.selected.id))) {
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
        options: modules.map((mod) => ({ value: mod.id, label: `${mod.prefix ?? ''} ${mod.title ?? mod.id}` })) },
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
  if (event.key === 'Escape') closeModal()
})

boot()
