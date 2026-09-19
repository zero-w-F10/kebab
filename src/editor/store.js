import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'

import { contentPathOf, doctor, flattenPages, listSites, loadSite } from '../doctor.js'

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

/** 按固定字段顺序写回，让 SVN diff 只显示真正改动的那几行。 */
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
      prefix: mod.prefix,
      ...rest(mod, ['id', 'title', 'prefix', 'pages']),
      pages: (mod.pages ?? []).map((page) => ({
        id: page.id,
        code: page.code,
        type: page.type,
        title: page.title,
        ...(page.entry ? { entry: page.entry } : {}),
        ...rest(page, ['id', 'code', 'type', 'title', 'entry']),
      })),
    })),
  }
}

function writeSite(dir, site) {
  writeFileSync(join(dir, SITE_FILE), `${JSON.stringify(normalizeSite(site), null, 2)}\n`, 'utf8')
}

/** 保存前的硬校验：id 与 code 不能撞车，形状要合法。软问题（dangling、orphan）交给 doctor 提示。 */
export function validateSite(site) {
  const problems = []
  const ids = new Map()
  const codes = new Map()
  const modules = new Map()

  for (const mod of site.modules ?? []) {
    if (!mod.id || !ID_PATTERN.test(mod.id)) problems.push(`module id 不合规：${mod.id ?? '(空)'}`)
    if (modules.has(mod.id)) problems.push(`module id 重复：${mod.id}`)
    modules.set(mod.id, mod)
    if (!mod.title) problems.push(`module ${mod.id} 缺标题`)

    for (const page of mod.pages ?? []) {
      if (!page.id || !ID_PATTERN.test(page.id)) problems.push(`page id 不合规：${page.id ?? '(空)'}`)
      if (!page.title) problems.push(`page ${page.id} 缺标题`)
      if (page.type !== 'doc' && page.type !== 'proto') problems.push(`page ${page.id} 的 type 只能是 doc 或 proto`)
      if (ids.has(page.id)) problems.push(`page id 重复：${page.id}`)
      if (codes.has(page.code)) problems.push(`page code 重复：${page.code}`)
      ids.set(page.id, page)
      codes.set(page.code, page)
    }
  }

  return problems
}

/** 分配 page code：module 内最大流水 +1。删页不复用号，重排序不改号，见 docs/adr/0005。 */
export function nextCode(mod) {
  const prefix = (mod.prefix ?? '').trim() || 'P'
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`)
  let max = 0
  for (const page of mod.pages ?? []) {
    const found = pattern.exec(page.code ?? '')
    if (found) max = Math.max(max, Number(found[1]))
  }
  return `${prefix}-${String(max + 1).padStart(2, '0')}`
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

export function createPage(workspace, id, { moduleId, pageId, type, title }, baseRevision) {
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

  const page = { id: pageId, code: nextCode(mod), type, title: title?.trim() || pageId }
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

  mod.pages = [...(mod.pages ?? []), page]
  writeSite(dir, site)
  return stateOf(workspace, id)
}

export function deletePage(workspace, id, pageId, { withFiles }, baseRevision) {
  const dir = resolveSite(workspace, id)
  assertWrite(dir, baseRevision)
  const site = loadSite(dir)

  const page = flattenPages(site).find((entry) => entry.id === pageId)
  if (!page) throw new BadRequest(`清单里没有这个 page：${pageId}`)
  const mod = (site.modules ?? []).find((entry) => entry.id === page.module.id)
  mod.pages = mod.pages.filter((entry) => entry.id !== pageId)
  writeSite(dir, site)
  if (withFiles) removeContent(dir, page)
  return stateOf(workspace, id)
}

export function createModule(workspace, id, { moduleId, title, prefix }, baseRevision) {
  const dir = resolveSite(workspace, id)
  assertWrite(dir, baseRevision)
  const site = loadSite(dir)

  if (!ID_PATTERN.test(moduleId ?? '')) {
    throw new BadRequest('module id 只能用小写英文、数字与短横线，且以字母或数字开头')
  }
  if ((site.modules ?? []).some((mod) => mod.id === moduleId)) {
    throw new BadRequest(`module id 已被占用：${moduleId}`)
  }
  if (!(prefix ?? '').trim()) throw new BadRequest('module 需要一个 code 前缀，例如 LO')

  site.modules = [...(site.modules ?? []), {
    id: moduleId,
    title: title?.trim() || moduleId,
    prefix: prefix.trim().toUpperCase(),
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
    for (const page of mod.pages ?? []) removeContent(dir, page)
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
  const { text: body, rescued } = externalizeInlineImages(dir, text)
  writeFileSync(contentPathOf(dir, page), body, 'utf8')
  return { rescued, ...stateOf(workspace, id) }
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

/**
 * orphan file 的两个出口之一：导入为页面。
 * 只往清单里加一条，磁盘上的文件原地不动 —— 它就是这一页的正文。
 */
export function importOrphan(workspace, id, { path, moduleId, title }, baseRevision) {
  const dir = resolveSite(workspace, id)
  assertWrite(dir, baseRevision)
  const site = loadSite(dir)

  const pageId = decodeOrphan(dir, path, site)
  if (flattenPages(site).some((page) => page.id === pageId)) {
    throw new BadRequest(`${pageId} 已经在清单里了`)
  }
  const mod = (site.modules ?? []).find((entry) => entry.id === moduleId)
  if (!mod) throw new BadRequest(`没有这个 module：${moduleId}`)

  const type = path.startsWith('prototypes/') ? 'proto' : 'doc'
  mod.pages = [...(mod.pages ?? []), {
    id: pageId,
    code: nextCode(mod),
    type,
    title: title?.trim() || pageId,
  }]
  writeSite(dir, site)
  return stateOf(workspace, id)
}

/** orphan file 的另一个出口：删除磁盘上的文件（清单里本来就没有它）。 */
export function deleteOrphan(workspace, id, path, baseRevision) {
  const dir = resolveSite(workspace, id)
  assertWrite(dir, baseRevision)
  const pageId = decodeOrphan(dir, path, loadSite(dir))

  if (path.startsWith('prototypes/')) rmSync(join(dir, 'prototypes', pageId), { recursive: true, force: true })
  else unlinkSync(join(dir, 'pages', `${pageId}.md`))
  return stateOf(workspace, id)
}

/** 把 doctor 报的 orphan 路径还原成 page id，并挡住越界与误伤。 */
function decodeOrphan(dir, path, site) {
  const isDoc = path.startsWith('pages/')
  const isProto = path.startsWith('prototypes/')
  if (!isDoc && !isProto) throw new BadRequest(`不是 pages/ 或 prototypes/ 下的路径：${path}`)

  const name = path.slice(path.indexOf('/') + 1)
  if (!name || name.includes('/') || name.startsWith('.')) throw new BadRequest(`路径不合法：${path}`)

  const pageId = isDoc ? name.replace(/\.[^.]+$/, '') : name
  if (!ID_PATTERN.test(pageId)) throw new BadRequest(`推导出的 page id 不合规：${pageId}`)
  if (flattenPages(site).some((page) => page.id === pageId)) {
    throw new BadRequest(`${pageId} 已被清单引用，不是孤儿文件`)
  }
  if (!existsSync(join(dir, isDoc ? 'pages' : 'prototypes', name))) {
    throw new BadRequest(`磁盘上没有这个文件：${path}`)
  }
  return pageId
}
