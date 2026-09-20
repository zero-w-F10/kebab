import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'

import { contentPathOf, doctor, flattenPages, listSites, loadSite, referencedAssets } from '../doctor.js'

/**
 * 编辑器的数据层：site.json 与磁盘之间的读写，以及陈旧写入的判定。
 * 构建器与编辑器共享 doctor —— 同一套一致性规则，两处不会各自漂移。
 */

const SITE_FILE = 'site.json'

/** 编辑器监听的范围，见 docs/adr/0006。prototypes/ 进库后不再改写，不入监听。 */
const WATCHED = ['pages', 'assets']

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export class BadRequest extends Error {}

export class StaleWrite extends Error {}

const sha1 = (data) => createHash('sha1').update(data).digest('hex')

function listFiles(dir) {
  const found = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) found.push(...listFiles(full))
    else found.push(full)
  }
  return found
}

/**
 * 内存状态的指纹：site.json 的内容加 pages/、assets/ 下每个文件的内容哈希。
 * 只认内容，不认时间戳 —— 时间戳会因同步、复制、时钟漂移而虚假变化，见 docs/adr/0006。
 */
export function hashTree(dir) {
  const parts = [`${SITE_FILE}:${sha1(readFileSync(join(dir, SITE_FILE), 'utf8'))}`]
  for (const sub of WATCHED) {
    const base = join(dir, sub)
    if (!existsSync(base)) continue
    for (const file of listFiles(base)) {
      const rel = `${sub}/${relative(base, file).replaceAll('\\', '/')}`
      parts.push(`${rel}:${sha1(readFileSync(file))}`)
    }
  }
  return sha1(parts.sort().join('\n'))
}

function assertFresh(dir, baseRevision) {
  const current = hashTree(dir)
  if (baseRevision !== current) {
    const error = new StaleWrite('磁盘内容已变化，内存状态已陈旧')
    error.revision = current
    throw error
  }
}

export function resolveSite(workspace, id) {
  const found = listSites(workspace).find((site) => site.id === id)
  if (!found) throw new BadRequest(`没有这个产品原型：${id}`)
  return found.dir
}

export function siteSummaries(workspace) {
  return listSites(workspace).map(({ id, dir }) => {
    const site = loadSite(dir)
    return { id, title: site.site?.title ?? id, subtitle: site.site?.subtitle ?? null }
  })
}

/** 一个 site 的完整内存状态：清单、指纹、以及 doctor 的核对结果。 */
export function stateOf(workspace, id) {
  const dir = resolveSite(workspace, id)
  const site = loadSite(dir)
  return { id, site, revision: hashTree(dir), problems: doctor(dir, site) }
}

const rest = (object, known) => Object.fromEntries(
  Object.entries(object).filter(([key]) => !known.includes(key)),
)

/**
 * 按固定字段顺序写回，让 SVN diff 只显示真正改动的那几行。
 * `code` 与 `prefix` 是已经退役的字段（见 docs/adr/0010）：它们不在这份白名单里，
 * 所以旧站点只要在编辑器里保存一次，残留的字段就被顺手剔掉了。
 * page 可以再挂下级，`children` 递归下去；空的下级不写进文件，叶子保持干净。
 */
const normalizePage = (page) => ({
  id: page.id,
  type: page.type,
  title: page.title,
  ...(page.entry ? { entry: page.entry } : {}),
  ...rest(page, ['id', 'code', 'type', 'title', 'entry', 'children']),
  ...((page.children ?? []).length > 0 ? { children: page.children.map(normalizePage) } : {}),
})

function normalizeSite(site) {
  const head = site.site ?? {}
  return {
    site: {
      title: head.title ?? '',
      ...(head.subtitle ? { subtitle: head.subtitle } : {}),
      ...rest(head, ['title', 'subtitle']),
    },
    modules: (site.modules ?? []).map((mod) => ({
      id: mod.id,
      title: mod.title,
      ...rest(mod, ['id', 'title', 'prefix', 'pages', 'code']),
      pages: (mod.pages ?? []).map(normalizePage),
    })),
  }
}

function writeSite(dir, site) {
  writeFileSync(join(dir, SITE_FILE), `${JSON.stringify(normalizeSite(site), null, 2)}\n`, 'utf8')
}

/** 保存前的硬校验：id 不能撞车，形状要合法。软问题（dangling、orphan）交给 doctor 提示。 */
export function validateSite(site) {
  const problems = []
  const ids = new Map()
  const modules = new Map()

  const walk = (pages) => {
    for (const page of pages) {
      if (!page.id || !ID_PATTERN.test(page.id)) problems.push(`page id 不合规：${page.id ?? '(空)'}`)
      if (!page.title) problems.push(`page ${page.id} 缺标题`)
      if (page.type !== 'doc' && page.type !== 'proto') problems.push(`page ${page.id} 的 type 只能是 doc 或 proto`)
      if (ids.has(page.id)) problems.push(`page id 重复：${page.id}`)
      ids.set(page.id, page)
      // 同一棵子树里不可能自己套自己（JSON 里没有引用），但手工写坏的 children 要拦住
      if (page.children !== undefined && !Array.isArray(page.children)) {
        problems.push(`page ${page.id} 的 children 必须是数组`)
        continue
      }
      walk(page.children ?? [])
    }
  }

  for (const mod of site.modules ?? []) {
    if (!mod.id || !ID_PATTERN.test(mod.id)) problems.push(`module id 不合规：${mod.id ?? '(空)'}`)
    if (modules.has(mod.id)) problems.push(`module id 重复：${mod.id}`)
    modules.set(mod.id, mod)
    if (!mod.title) problems.push(`module ${mod.id} 缺标题`)
    walk(mod.pages ?? [])
  }

  return problems
}

/**
 * 一页连同它的全部下级，前序。
 * 删除、连带删磁盘文件、以及编辑器的确认框都要数这棵子树。
 */
export function subtreePages(page) {
  return [page, ...(page.children ?? []).flatMap(subtreePages)]
}

/**
 * 在整棵树里找一页，连同它所在的那个数组、所属 module、上级与深度。
 * 删除与搬家都要从这里摘，所以不能只返回 page 本身。
 */
export function locatePageIn(site, pageId) {
  const walk = (list, module, parent, depth) => {
    for (let index = 0; index < list.length; index += 1) {
      const page = list[index]
      if (page.id === pageId) return { page, list, index, module, parent, depth }
      const deeper = walk(page.children ?? [], module, page, depth + 1)
      if (deeper) return deeper
    }
    return null
  }
  for (const mod of site.modules ?? []) {
    const found = walk(mod.pages ?? [], mod, null, 1)
    if (found) return found
  }
  return null
}

function assertWrite(dir, baseRevision) {
  assertFresh(dir, baseRevision)
}

function writeTree(workspace, id, site, baseRevision) {
  const dir = resolveSite(workspace, id)
  assertWrite(dir, baseRevision)
  const problems = validateSite(site)
  if (problems.length > 0) throw new BadRequest(problems.join('；'))
  writeSite(dir, site)
  return stateOf(workspace, id)
}

/** 整棵树的保存：排序、改标题、站点标题都走这里。 */
export function saveTree(workspace, id, tree, baseRevision) {
  return writeTree(workspace, id, tree, baseRevision)
}

/** 页面文件在磁盘上的落点，由 id 与类型推出，见 docs/design.md 的数据模型。 */
function removeContent(dir, page) {
  const target = contentPathOf(dir, page)
  if (!existsSync(target)) return
  if (page.type === 'proto') rmSync(target, { recursive: true, force: true })
  else unlinkSync(target)
}

export function createPage(workspace, id, { moduleId, pageId, type, title, parentId }, baseRevision) {
  const dir = resolveSite(workspace, id)
  assertWrite(dir, baseRevision)
  const site = loadSite(dir)

  if (!ID_PATTERN.test(pageId ?? '')) {
    throw new BadRequest('page id 只能用小写英文、数字与短横线，且以字母或数字开头')
  }
  if (flattenPages(site).some((page) => page.id === pageId)) {
    throw new BadRequest(`page id 已被占用：${pageId}`)
  }
  const mod = (site.modules ?? []).find((entry) => entry.id === moduleId)
  if (!mod) throw new BadRequest(`没有这个 module：${moduleId}`)
  if (type !== 'doc' && type !== 'proto') throw new BadRequest('type 只能是 doc 或 proto')

  // 给了 parentId 就是给某一页当下级。正文位置由 id 推出、与层级无关，所以只是清单里挂在哪儿的差别
  const parent = parentId ? locatePageIn(site, parentId) : null
  if (parentId && !parent) throw new BadRequest(`没有这个上级 page：${parentId}`)
  if (parent && parent.module.id !== moduleId) {
    throw new BadRequest(`上级 page ${parentId} 不在模块 ${moduleId} 里`)
  }

  const page = { id: pageId, type, title: title?.trim() || pageId }
  if (type === 'doc') {
    const file = join(dir, 'pages', `${pageId}.md`)
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '', 'utf8')
    }
  } else {
    // 原型目录由使用者自己放进来（AI 导出的整个目录），这里只占位，
    // 缺入口时 doctor 会报 dangling，UI 上标为「待放原型」。
    mkdirSync(join(dir, 'prototypes', pageId), { recursive: true })
  }

  if (parent) parent.page.children = [...(parent.page.children ?? []), page]
  else mod.pages = [...(mod.pages ?? []), page]
  writeSite(dir, site)
  return stateOf(workspace, id)
}

/** 删一页连带它的整棵子树 —— 留着下级会变成没有父级的悬空节点。 */
export function deletePage(workspace, id, pageId, { withFiles }, baseRevision) {
  const dir = resolveSite(workspace, id)
  assertWrite(dir, baseRevision)
  const site = loadSite(dir)

  const found = locatePageIn(site, pageId)
  if (!found) throw new BadRequest(`清单里没有这个 page：${pageId}`)
  const removed = subtreePages(found.page)
  found.list.splice(found.index, 1)
  writeSite(dir, site)
  if (withFiles) {
    for (const page of removed) removeContent(dir, page)
  }
  return stateOf(workspace, id)
}

export function createModule(workspace, id, { moduleId, title }, baseRevision) {
  const dir = resolveSite(workspace, id)
  assertWrite(dir, baseRevision)
  const site = loadSite(dir)

  if (!ID_PATTERN.test(moduleId ?? '')) {
    throw new BadRequest('module id 只能用小写英文、数字与短横线，且以字母或数字开头')
  }
  if ((site.modules ?? []).some((mod) => mod.id === moduleId)) {
    throw new BadRequest(`module id 已被占用：${moduleId}`)
  }

  site.modules = [...(site.modules ?? []), {
    id: moduleId,
    title: title?.trim() || moduleId,
    pages: [],
  }]
  writeSite(dir, site)
  return stateOf(workspace, id)
}

export function deleteModule(workspace, id, moduleId, { withFiles }, baseRevision) {
  const dir = resolveSite(workspace, id)
  assertWrite(dir, baseRevision)
  const site = loadSite(dir)

  const mod = (site.modules ?? []).find((entry) => entry.id === moduleId)
  if (!mod) throw new BadRequest(`清单里没有这个 module：${moduleId}`)
  site.modules = site.modules.filter((entry) => entry.id !== moduleId)
  writeSite(dir, site)
  if (withFiles) {
    // 下级也在这个 module 的子树里，一并清掉
    for (const page of (mod.pages ?? []).flatMap(subtreePages)) removeContent(dir, page)
  }
  return stateOf(workspace, id)
}

export function readDoc(workspace, id, pageId) {
  const dir = resolveSite(workspace, id)
  const page = flattenPages(loadSite(dir)).find((entry) => entry.id === pageId)
  if (!page) throw new BadRequest(`清单里没有这个 page：${pageId}`)
  if (page.type !== 'doc') throw new BadRequest(`${pageId} 不是 doc 页`)
  const file = contentPathOf(dir, page)
  return { revision: hashTree(dir), text: existsSync(file) ? readFileSync(file, 'utf8') : null }
}

export function saveDoc(workspace, id, pageId, text, baseRevision) {
  const dir = resolveSite(workspace, id)
  assertWrite(dir, baseRevision)
  const page = flattenPages(loadSite(dir)).find((entry) => entry.id === pageId)
  if (!page) throw new BadRequest(`清单里没有这个 page：${pageId}`)
  if (page.type !== 'doc') throw new BadRequest(`${pageId} 不是 doc 页`)
  const { text: withoutInline, rescued } = externalizeInlineImages(dir, text)
  const { text: body, stripped } = stripEmptyBreaks(withoutInline)
  writeFileSync(contentPathOf(dir, page), body, 'utf8')
  return { rescued, stripped, ...stateOf(workspace, id) }
}

const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
const MAX_ASSET_BYTES = 20 * 1024 * 1024

/**
 * 图片进 assets/：文件名清洗后落盘，重名自动让路 —— 编辑器里粘贴截图走这里。
 * 同样校验指纹：磁盘已被外部改动时不写盘，免得编辑器带着旧状态继续操作。
 */
export function saveAsset(workspace, id, rawName, buffer, baseRevision) {
  const dir = resolveSite(workspace, id)
  assertWrite(dir, baseRevision)

  const ext = extname(rawName ?? '').toLowerCase()
  if (!ASSET_EXT.has(ext)) throw new BadRequest(`不支持的图片类型：${ext || '(没有扩展名)'}`)
  if (buffer.length === 0) throw new BadRequest('图片是空的')
  if (buffer.length > MAX_ASSET_BYTES) throw new BadRequest('图片超过 20MB，先压一下再放进来')

  // 中文名留着（截图多半叫「登录页截图.png」），只把路径符号与特殊字符压成短横线
  const name = writeAsset(dir, basename(rawName, ext), ext, buffer)
  return { path: `assets/${name}`, ...stateOf(workspace, id) }
}

/** 落一个素材文件：文件名清洗、重名让路，返回最终文件名。 */
function writeAsset(dir, stem, ext, buffer) {
  const safe = (stem ?? '').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'image'
  const assets = join(dir, 'assets')
  mkdirSync(assets, { recursive: true })

  let name = `${safe}${ext}`
  for (let index = 2; existsSync(join(assets, name)); index += 1) name = `${safe}-${index}${ext}`
  writeFileSync(join(assets, name), buffer)
  return name
}

const INLINE_IMAGE = /!\[([^\]]*)\]\(data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)\)/g
const DATA_EXT = { png: '.png', jpeg: '.jpg', jpg: '.jpg', gif: '.gif', webp: '.webp', 'svg+xml': '.svg' }

/**
 * 正文里不该出现内联 base64：那是编辑器把图片直接塞进文本的后果，
 * md 会膨胀，SVN diff 会变成一团乱码。落盘前把这类图片抽成 assets/ 里的文件，
 * 兜住任何一条没走上传的粘贴路径 —— 正确性不该取决于浏览器把事件派发给了谁。
 */
function externalizeInlineImages(dir, text) {
  let rescued = 0
  const next = text.replace(INLINE_IMAGE, (whole, alt, subtype, payload) => {
    const ext = DATA_EXT[subtype.toLowerCase()]
    if (!ext) return whole
    const buffer = Buffer.from(payload.replace(/\s+/g, ''), 'base64')
    if (buffer.length === 0 || buffer.length > MAX_ASSET_BYTES) return whole
    rescued += 1
    return `![${alt}](assets/${writeAsset(dir, 'pasted', ext, buffer)})`
  })
  return { text: next, rescued }
}

/** 孤立成行、整行只有一个 <br> —— 编辑器里空段落序列化后的样子。 */
const EMPTY_BREAK_LINE = /^[ \t]*<br\s*\/?>[ \t]*(?:\r?\n|$)/gim

/**
 * 编辑器里的空段落在 Markdown 里表达不出来，Crepe 序列化时会留一行孤零零的 <br />。
 * 渲染器开着 html: false，那行到了产物里会原样显示成「<br />」四个字 —— 它是序列化的
 * 副产物，不是使用者写的内容。落盘前抹掉；行内出现的 <br> 是使用者自己写的换行，不碰。
 */
function stripEmptyBreaks(text) {
  let stripped = 0
  const next = text.replace(EMPTY_BREAK_LINE, () => {
    stripped += 1
    return ''
  })
  return { text: next, stripped }
}

/* ---------- 孤儿文件：收编为页面 ---------- */

/**
 * 只认 pages/ 或 prototypes/ 下的单个条目，挡掉越界与多层路径。
 * 这里刻意不校验 id —— 文件名当不了 page id（中文、带点、不是 .md）是常态，
 * 收编时改名让它合规，删除时更是跟 id 无关。
 */
function orphanFileOf(dir, path) {
  const isDoc = typeof path === 'string' && path.startsWith('pages/')
  const isProto = typeof path === 'string' && path.startsWith('prototypes/')
  if (!isDoc && !isProto) throw new BadRequest(`不是 pages/ 或 prototypes/ 下的路径：${path}`)

  const name = path.slice(path.indexOf('/') + 1)
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    throw new BadRequest(`路径不合法：${path}`)
  }
  const root = join(dir, isDoc ? 'pages' : 'prototypes')
  return { isDoc, name, file: join(root, name) }
}

/** 文件名 → 合规 page id。纯中文、纯符号折不出东西时返回 null，由调用方另编号。 */
function idFromName(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return ID_PATTERN.test(slug) ? slug : null
}

/** 正文里第一条标题：收编时拿它当页面标题的默认值。 */
function firstHeading(text) {
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lines[index])
    if (match) return { level: match[1].length, title: match[2].trim(), line: index }
  }
  return null
}

/** 抹掉顶部那行 H1 与它后面的空行，其余一个字节都不动。 */
function stripHeading(text, heading) {
  const lines = text.split('\n')
  let end = heading.line + 1
  while (end < lines.length && lines[end].trim() === '') end += 1
  return [...lines.slice(0, heading.line), ...lines.slice(end)].join('\n')
}

/** 中文名之类的折不出 id 时按序号编：doc-1、doc-2…… 跳过已被占用的。 */
function nextFreeId(taken, base = 'doc') {
  for (let n = 1; ; n += 1) {
    const id = `${base}-${n}`
    if (!taken.has(id)) return id
  }
}

/** 清单里已经声明的 page id。与「磁盘上占着名字的」分开：前者撞上就得另编号。 */
function declaredIds(site) {
  return new Set(flattenPages(site).map((page) => page.id))
}

/** 孤儿文件其实是某一页的正文时（Windows 上文件名只差大小写）的解释。 */
const samePageReason = (path) => `${path} 已经是清单里某一页的正文，只是文件名大小写对不上；把文件名改成与 page id 完全一致再收编`

/** 清单里每一页正文的真实路径。文件不存在（悬空引用）时退回字面路径。 */
function declaredFilesOf(dir, site) {
  return new Set(flattenPages(site).map((page) => realPath(contentPathOf(dir, page))))
}

/**
 * 比对「是不是同一个文件」用真实路径：Windows 上 `Extra.md` 与 `extra.md` 指向同一个文件，
 * 字面量比较看不出来。文件不存在（悬空引用）时退回字面路径。
 */
function realPath(file) {
  try {
    return realpathSync.native(file)
  } catch {
    return file
  }
}

/** 已经被占用的 page id：清单里声明的，加上磁盘上躺着的文件名与原型目录名。 */
function occupiedIds(dir, site) {
  const taken = declaredIds(site)
  for (const sub of ['pages', 'prototypes']) {
    const base = join(dir, sub)
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) {
      if (name.startsWith('.')) continue
      taken.add(sub === 'pages' ? name.replace(/\.[^.]+$/, '') : name)
    }
  }
  return taken
}

/**
 * 一个孤儿文件的收编计划：算它变成哪一页、标题叫什么、要不要改名、正文要不要动。
 * 纯函数不碰磁盘 —— 预览与实际收编走的是同一份判断，两处不会各自漂移。
 *
 * 三条规则值得记着：
 * - doc 页的正文位置写死是 `pages/<id>.md`，文件名必须**正好**是 `<id>.md`，大小写也算。
 *   Windows 上 `CONTEXT.md` 与 `context.md` 是同一个文件，但 doctor 比文件名是大小写敏感的，
 *   不改名就会既认不出这一页、又把它一直报成孤儿。改名是唯一会动使用者文件的地方，先列给人看
 * - 正文的第一条标题拿来当页面标题；若它是顶格的 H1，就是这一页自己的标题，
 *   正文里那几行抹掉 —— 留着会跟页头的大标题重复，见 docs/authoring.md
 * - id 已经被清单占用的不再顶上去（那会写出重复 id），改用序号编
 */
function planOrphan(dir, site, path, { taken, declared, declaredFiles }, override = {}) {
  const { isDoc, name, file } = orphanFileOf(dir, path)
  if (!existsSync(file)) return { ok: false, reason: '磁盘上没有这个文件了' }
  // 按真实路径比：Windows 上 `Extra.md` 与 `extra.md` 是同一个文件，那一页的正文就是它，
  // 不能当孤儿搬走（Linux 上它们是两个文件，各算各的）
  if (isDoc && declaredFiles.has(realPath(file))) return { ok: false, reason: samePageReason(path) }

  if (!isDoc) {
    if (!ID_PATTERN.test(name)) {
      return { ok: false, reason: `原型目录名「${name}」不能当 page id，先把目录改成小写英文` }
    }
    return { ok: true, item: { path, kind: 'proto', id: name, title: name, file, target: file, renamed: null } }
  }

  const body = readFileSync(file, 'utf8')
  const heading = firstHeading(body)
  const stem = name.replace(/\.[^.]+$/, '')
  const wanted = typeof override.pageId === 'string' ? override.pageId.trim() : ''
  if (wanted && !ID_PATTERN.test(wanted)) {
    throw new BadRequest(`page id 不合规：${wanted}（只收小写英文、数字、短横线，且以字母或数字开头）`)
  }
  if (wanted && taken.has(wanted) && wanted !== stem) throw new BadRequest(`${wanted} 已经被占用了`)

  const derived = idFromName(stem)
  const id = wanted || (derived && !declared.has(derived) ? derived : nextFreeId(taken))
  const targetName = `${id}.md`
  const target = join(dir, 'pages', targetName)
  // 目录里真的躺着这个名字的文件（大小写敏感地存在）就绕开它 —— 只差大小写的那个是自己
  if (targetName !== name && readdirSync(join(dir, 'pages')).includes(targetName)) {
    if (wanted) throw new BadRequest(`pages/${targetName} 已经存在了，换个 page id`)
    return { ok: false, reason: `pages/${targetName} 已经存在了` }
  }

  // 自己填了标题就以他填的为准；正文顶格那行 H1 是这一页自己的标题，一律抹掉 ——
  // 留着会跟页头的大标题重复，见 docs/authoring.md
  const custom = typeof override.title === 'string' ? override.title.trim() : ''
  return {
    ok: true,
    item: {
      path,
      kind: 'doc',
      id,
      title: custom || heading?.title || stem,
      file,
      target,
      renamed: targetName === name ? null : targetName,
      titleFromHeading: !custom && Boolean(heading),
      body: heading?.level === 1 ? stripHeading(body, heading) : null,
    },
  }
}

/** 收编计划里给编辑器看的那部分：内部路径与正文不必出门。 */
const publicItem = ({ path, kind, id, title, renamed, titleFromHeading }) => ({
  path, kind, id, title, renamed, titleFromHeading,
})

/** 当前全部孤儿页文件的收编计划。只读，给编辑器预览用。 */
export function orphanPlan(workspace, id) {
  const dir = resolveSite(workspace, id)
  const site = loadSite(dir)
  const scope = {
    taken: occupiedIds(dir, site),
    declared: declaredIds(site),
    declaredFiles: declaredFilesOf(dir, site),
  }
  const items = []
  const skipped = []

  for (const problem of doctor(dir, site)) {
    if (problem.kind !== 'orphan') continue
    const plan = planOrphan(dir, site, problem.path, scope)
    if (!plan.ok) {
      skipped.push({ path: problem.path, reason: plan.reason })
      continue
    }
    scope.taken.add(plan.item.id)
    items.push(publicItem(plan.item))
  }

  return { items, skipped }
}

/**
 * 把孤儿文件收编成页面：清单里加条目的同时，需要改名的文件也一并改名。
 * 先算完全部计划再落盘，中途一个失败不影响其余的；清单只写一次。
 */
export function importOrphans(workspace, id, { moduleId, items }, baseRevision) {
  const dir = resolveSite(workspace, id)
  assertWrite(dir, baseRevision)
  const site = loadSite(dir)

  const mod = (site.modules ?? []).find((entry) => entry.id === moduleId)
  if (!mod) throw new BadRequest(`没有这个 module：${moduleId}`)

  const requested = Array.isArray(items) ? items : []
  if (requested.length === 0) throw new BadRequest('没有要收编的文件')

  const declaredFiles = declaredFilesOf(dir, site)
  const scope = { taken: occupiedIds(dir, site), declared: declaredIds(site), declaredFiles }
  const planned = []
  const skipped = []

  for (const request of requested) {
    const { file } = orphanFileOf(dir, request.path)
    if (declaredFiles.has(realPath(file))) throw new BadRequest(`${request.path} 已经被清单引用了，不是孤儿文件`)

    const plan = planOrphan(dir, site, request.path, scope, request)
    if (!plan.ok) {
      skipped.push({ path: request.path, reason: plan.reason })
      continue
    }
    scope.taken.add(plan.item.id)
    planned.push(plan.item)
  }

  const imported = []
  for (const item of planned) {
    if (item.renamed) renameWithin(dir, item.file, item.target)
    if (item.body !== null) writeFileSync(item.target, item.body, 'utf8')
    mod.pages = [...(mod.pages ?? []), { id: item.id, type: item.kind, title: item.title }]
    imported.push(publicItem(item))
  }
  if (imported.length > 0) writeSite(dir, site)

  return { ...stateOf(workspace, id), imported, skipped }
}

/**
 * 改名。只差大小写的要绕一下：Windows 的 MoveFile 对纯大小写改名不一定真的改掉目录项里的名字，
 * 而 doctor 比文件名是大小写敏感的 —— 没改掉就永远认不出这一页。先挪到临时名再落位。
 * 临时名以点开头，doctor 与小工具都跳过它，中途出事也不会被当成内容。
 */
function renameWithin(dir, from, to) {
  if (from === to) return
  if (from.toLowerCase() !== to.toLowerCase()) {
    renameSync(from, to)
    return
  }
  const temp = join(dir, 'pages', `.kebab-rename-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.md`)
  renameSync(from, temp)
  renameSync(temp, to)
}

/** 单个孤儿文件的收编：批量那条路的特例，编辑器逐行导入时走这里。 */
export function importOrphan(workspace, id, { path, moduleId, pageId, title }, baseRevision) {
  return importOrphans(workspace, id, {
    moduleId,
    items: [{ path, pageId, title }],
  }, baseRevision)
}

/** 孤儿文件的另一个出口：删除磁盘上的文件（清单里本来就没有它）。 */
export function deleteOrphan(workspace, id, path, baseRevision) {
  const dir = resolveSite(workspace, id)
  assertWrite(dir, baseRevision)

  const { isDoc, file } = orphanFileOf(dir, path)
  if (!existsSync(file)) throw new BadRequest(`磁盘上没有这个文件：${path}`)
  if (flattenPages(loadSite(dir)).some((page) => contentPathOf(dir, page) === file)) {
    throw new BadRequest(`${path} 已经被清单引用了，先删掉那一页再删文件`)
  }

  if (isDoc) unlinkSync(file)
  else rmSync(file, { recursive: true, force: true })
  return stateOf(workspace, id)
}

/**
 * 闲置素材的出口：删掉 assets/ 下已经没有 doc 页引用的文件。
 * 删之前照着磁盘当下的正文再核一遍引用 —— 编辑器送来的核对结果是它自己那份快照，
 * 可能已经过期；删除不可恢复，宁可拒绝，也不凭过期的判断误删。
 */
export function deleteUnusedAsset(workspace, id, path, baseRevision) {
  const dir = resolveSite(workspace, id)
  assertWrite(dir, baseRevision)

  const name = assetNameOf(path)
  const file = join(dir, 'assets', name)
  if (!existsSync(file) || statSync(file).isDirectory()) throw new BadRequest(`磁盘上没有这个素材：${path}`)
  if (referencedAssets(dir, flattenPages(loadSite(dir))).has(name.toLowerCase())) {
    throw new BadRequest(`${path} 还被正文引用着，先改正文再删文件`)
  }

  unlinkSync(file)
  return stateOf(workspace, id)
}

/** 只认 assets/ 下的相对文件名，挡掉绝对路径与 ../ 越界。 */
function assetNameOf(path) {
  const name = String(path ?? '').replace(/^assets\//, '')
  if (!name || name === path || name.includes('..') || name.includes('\\') || name.startsWith('/')) {
    throw new BadRequest(`不是 assets/ 下的合法路径：${path}`)
  }
  return name
}
