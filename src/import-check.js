import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

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

function walk(dir, visit) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, visit)
    else visit(full)
  }
}

export function checkPrototype(dir) {
  const problems = []

  walk(dir, (file) => {
    const ext = extname(file).toLowerCase()
    if (!SCANNED.has(ext)) return
    const rel = relative(dir, file).replaceAll('\\', '/')
    const text = readFileSync(file, 'utf8')

    if (MODULE_SCRIPT.test(text)) {
      problems.push({
        kind: 'module-script',
        message: `${rel}：用了 <script type="module">，file:// 下会被浏览器按 CORS 拦掉`,
      })
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
      problems.push({
        kind: 'remote-asset',
        message: `${rel}：${remote.length} 处会向公网发请求，内网离线时加载不到 —— ${remote.slice(0, 3).join('、')}`,
      })
    }

    if (LOCAL_FETCH.test(text)) {
      problems.push({
        kind: 'local-fetch',
        message: `${rel}：用了 fetch 或 XMLHttpRequest，file:// 下读不到资源`,
      })
    }
  })

  return problems
}
