import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'

/**
 * 导入校验：原型目录进库前，拦下会在 file:// 下白屏的写法。见 docs/adr/0007。
 *
 * 只匹配「会真正发起请求」的位置，不匹配普通文本里的 URL ——
 * React 与 antd 的生产产物里塞满了文档链接（https://ant.design/...）和
 * XML 命名空间（http://www.w3.org/2000/svg），那些只是字符串，不发起请求。
 * 把它们报出来只会逼使用者习惯性加 --force，让校验失去意义。
 */
const SCANNED = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.css'])
const SCRIPT_EXT = new Set(['.js', '.mjs', '.cjs'])

const MODULE_SCRIPT = /<script[^>]*\btype\s*=\s*["']module["']/i

// HTML 里会真正发起请求的属性。刻意不匹配 <a href> 与 <form action>：
// 它们是点击后才走的链接，不会造成白屏。
const HTML_REMOTE = /<(?:script|img|iframe|source|embed|video|audio|track|input|link|object)\b[^>]*?\b(?:src|href|data|poster)\s*=\s*["']?(?:https?:)?\/\/[^"'\s>]+/gi

// CSS 的 url() 与 @import。data: 内联资源不含 //，不会被匹配。
const CSS_REMOTE = /(?:url\(\s*["']?|@import\s+(?:url\(\s*)?["']?)(?:https?:)?\/\/[^"'\s)]+/gi

// file:// 下任何 fetch 都读不到资源，无论目标是相对路径还是公网。
const LOCAL_FETCH = /\bfetch\s*\(\s*["'`]|\bnew\s+XMLHttpRequest\s*\(/

// 与上面同一批「会发起请求的位置」，只是这里取属性值本身，用来核对它是否真的落地。
const HTML_RESOURCE = /<(?:script|img|iframe|source|embed|video|audio|track|input|link|object)\b[^>]*?\b(?:src|href|data|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi
const CSS_TARGET = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"'\s)]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi
// JS 里只认带引号的 url()：那是 CSS-in-JS 的写法，不带引号的形式与普通函数调用无法区分。
const JS_TARGET = /\burl\(\s*(?:"([^"]*)"|'([^']*)')\s*\)/gi

// 每类问题的出口。校验的意义在于把「哪里错了」和「怎么办」一起交出去。
const HINTS = {
  'module-script': '让 AI 重新导出成自包含的普通 <script> 版本；确认无碍时用 --force 强制通过',
  'remote-asset': '把外链资源下载进原型目录再改成相对路径；内网离线时这些请求必然失败',
  'missing-asset': '把缺的文件补进原型目录的对应位置，或让 AI 重新导出完整的目录',
  'root-relative': '改成相对路径（如 ./assets/logo.png）；file:// 下 / 开头会指向磁盘根',
  'local-fetch': '让 AI 把要读的内容内联进脚本，或重新导出不读本地文件的版本',
}

function walk(dir, visit) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, visit)
    else visit(full)
  }
}

const captured = (match) => match.slice(1).find((group) => group !== undefined)

/** 一个文件里会发起请求的本地引用，按文件类型取位置。 */
function refsIn(ext, text) {
  const patterns = ext === '.css'
    ? [CSS_TARGET]
    : SCRIPT_EXT.has(ext) ? [JS_TARGET] : [HTML_RESOURCE, CSS_TARGET]
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map(captured))
}

const decodePath = (path) => {
  try {
    return decodeURIComponent(path)
  } catch {
    return path // 含 % 但不构成编码序列，按原样找
  }
}

/**
 * 把一处引用与磁盘对一遍，返回它的问题类型；返回 null 表示这里没有「引用了却不存在的东西」：
 * 空值、页内锚点、data: 之类的内联资源、公网地址（归 remote-asset 管）。
 */
function lookupRef(file, raw) {
  if (typeof raw !== 'string') return null
  const ref = raw.trim()
  if (ref === '' || ref.startsWith('#')) return null
  if (ref.startsWith('//')) return null // 协议相对，属公网
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return null // 显式协议：data:、blob:、https: 等

  const path = ref.split(/[#?]/)[0] // 查询串与锚点不参与定位
  if (path === '') return null

  if (path.startsWith('/')) return { kind: 'root-relative', ref: path }
  return existsSync(resolve(dirname(file), decodePath(path)))
    ? null
    : { kind: 'missing-asset', ref: path }
}

export function checkPrototype(dir) {
  const problems = []
  const report = (kind, message) => problems.push({ kind, message, hint: HINTS[kind] })

  walk(dir, (file) => {
    const ext = extname(file).toLowerCase()
    if (!SCANNED.has(ext)) return
    const rel = relative(dir, file).replaceAll('\\', '/')
    const text = readFileSync(file, 'utf8')

    if (MODULE_SCRIPT.test(text)) {
      report('module-script', `${rel}：用了 <script type="module">，file:// 下会被浏览器按 CORS 拦掉`)
    }

    const hits = []
    if (ext === '.css') {
      hits.push(...(text.match(CSS_REMOTE) ?? []))
    } else if (!SCRIPT_EXT.has(ext)) {
      // HTML：资源属性，外加内联 <style> 里的 url()
      hits.push(...(text.match(HTML_REMOTE) ?? []), ...(text.match(CSS_REMOTE) ?? []))
    }

    const remote = [...new Set(hits)]
    if (remote.length > 0) {
      report('remote-asset', `${rel}：${remote.length} 处会向公网发请求，内网离线时加载不到 —— ${remote.slice(0, 3).join('、')}`)
    }

    // 引用的东西是否真的在原型目录里。缺文件与写法在 file:// 下不成立，分开报。
    const dangling = { 'missing-asset': [], 'root-relative': [] }
    for (const ref of refsIn(ext, text)) {
      const found = lookupRef(file, ref)
      if (found) dangling[found.kind].push(found.ref)
    }

    const missing = [...new Set(dangling['missing-asset'])]
    if (missing.length > 0) {
      report('missing-asset', `${rel}：引用了 ${missing.length} 个原型目录里没有的文件 —— ${missing.slice(0, 3).join('、')}`)
    }

    const rooted = [...new Set(dangling['root-relative'])]
    if (rooted.length > 0) {
      report('root-relative', `${rel}：${rooted.length} 处以 / 开头引用本地资源，file:// 下会指向磁盘根 —— ${rooted.slice(0, 3).join('、')}`)
    }

    if (LOCAL_FETCH.test(text)) {
      report('local-fetch', `${rel}：用了 fetch 或 XMLHttpRequest，file:// 下读不到资源`)
    }
  })

  return problems
}
