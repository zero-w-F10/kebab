import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

/**
 * 导入校验：原型目录进库前，拦下会在 file:// 下白屏的写法。
 * 见 docs/adr/0007。
 */
const SCANNED = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.css'])

const MODULE_SCRIPT = /<script[^>]*\btype\s*=\s*["']module["']/i
// 宽松匹配任何公网 URL 字面量：src/href 属性、CSS 的 url() 与 @import 都覆盖。
// 宁可偶尔误报（有 --force 兜底），也不要漏掉一个会让同事白屏的外链。
const REMOTE_URL = /(?:https?:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#][^\s"')<>]*)?/gi
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
    if (!SCANNED.has(extname(file).toLowerCase())) return
    const rel = relative(dir, file).replaceAll('\\', '/')
    const text = readFileSync(file, 'utf8')

    if (MODULE_SCRIPT.test(text)) {
      problems.push({
        kind: 'module-script',
        message: `${rel}：用了 <script type="module">，file:// 下会被浏览器按 CORS 拦掉`,
      })
    }

    const remote = [...new Set(text.match(REMOTE_URL) ?? [])]
    if (remote.length > 0) {
      problems.push({
        kind: 'remote-asset',
        message: `${rel}：引用了公网资源，内网离线时加载不到 —— ${remote.slice(0, 3).join('、')}`,
      })
    }

    if (LOCAL_FETCH.test(text)) {
      problems.push({
        kind: 'local-fetch',
        message: `${rel}：用了 fetch 或 XMLHttpRequest，file:// 下读不到本地资源`,
      })
    }
  })

  return problems
}
