import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 读 site.json —— 一个产品原型的导航树的唯一真相。 */
export function loadSite(dir) {
  return JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8'))
}

/**
 * 发现 sites/ 下的全部产品原型。目录名就是 site id。
 * 目录本身就是真相，不额外维护一份索引。
 */
export function listSites(workspace) {
  const base = join(workspace, 'sites')
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .filter((entry) => existsSync(join(base, entry.name, 'site.json')))
    .map((entry) => ({ id: entry.name, dir: join(base, entry.name) }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 把模块树摊平成页面列表，每项带着所属模块。
 * 页面可以再挂下级，所以按前序递归下来 —— 父级一定排在它的下级前面。
 */
export function flattenPages(site) {
  const walk = (pages, module) => (pages ?? []).flatMap((page) => [
    { ...page, module },
    ...walk(page.children, module),
  ])
  return (site.modules ?? []).flatMap((mod) => walk(mod.pages, mod))
}

export const entryOf = (page) => page.entry ?? 'index.html'

/** 页面在磁盘上的落点：doc 页是单个 md，proto 页是整个目录。 */
export function contentPathOf(dir, page) {
  return page.type === 'proto'
    ? join(dir, 'prototypes', page.id)
    : join(dir, 'pages', `${page.id}.md`)
}

/**
 * 一致性核对：找出清单与磁盘之间的失配。
 * 返回问题列表，空列表表示一致。
 */
export function doctor(dir, site) {
  const problems = []
  const pages = flattenPages(site)

  // 页面只有 id 这一个身份：标题是给人看的，可以重复，也不参与寻址
  const seen = new Map()
  for (const page of pages) {
    const first = seen.get(page.id)
    if (first) {
      problems.push({
        kind: 'duplicate',
        message: `id 重复：${page.id}（${first.title} 与 ${page.title}）`,
      })
    } else {
      seen.set(page.id, page)
    }
  }

  for (const page of pages) {
    if (page.type === 'proto') {
      const entry = join(contentPathOf(dir, page), entryOf(page))
      if (!existsSync(entry)) {
        problems.push({
          kind: 'dangling',
          message: `${page.title}（${page.id}）：找不到原型入口 prototypes/${page.id}/${entryOf(page)}`,
        })
      }
    } else if (!existsSync(contentPathOf(dir, page))) {
      problems.push({
        kind: 'dangling',
        message: `${page.title}（${page.id}）：找不到 pages/${page.id}.md`,
      })
    }
  }

  const declared = new Set(pages.map((page) => page.id))
  for (const sub of ['pages', 'prototypes']) {
    const abs = join(dir, sub)
    if (!existsSync(abs)) continue
    for (const name of readdirSync(abs)) {
      if (name.startsWith('.')) continue // 编辑器临时文件与系统文件，不是内容
      const id = name.replace(/\.[^.]+$/, '')
      if (!declared.has(id)) {
        problems.push({
          kind: 'orphan',
          // path 给编辑器用：它要凭这个路径把孤儿文件导入或删除
          path: `${sub}/${name}`,
          message: `孤儿文件：${sub}/${name} 没有被清单引用`,
        })
      }
    }
  }

  // 素材：磁盘上躺着、但没有任何 doc 页引用它 —— 在编辑器里删掉图之后留下的那些
  const assets = join(dir, 'assets')
  if (existsSync(assets)) {
    const used = referencedAssets(dir, pages)
    for (const name of listAssets(assets)) {
      if (used.has(name.toLowerCase())) continue
      problems.push({
        kind: 'unused-asset',
        // path 给编辑器用：它要凭这个路径把文件删掉
        path: `assets/${name}`,
        message: `闲置素材：assets/${name} 没有被任何 doc 页引用`,
      })
    }
  }

  return problems
}

/** 正文里对素材的引用一律按站点根写：`assets/<文件名>`，见 docs/design.md。 */
const ASSET_REFERENCE = /assets\/([^\s)"'<>\\]+)/g

/**
 * doc 正文引用到的素材名，键转成小写 —— 大小写不敏感，宁可漏报「闲置」也不能误删。
 * 文件名被 URL 编码过（中文名）的写法也算引用。
 */
export function referencedAssets(dir, pages) {
  const used = new Set()
  for (const page of pages) {
    if (page.type !== 'doc') continue
    const file = contentPathOf(dir, page)
    if (!existsSync(file)) continue
    for (const match of readFileSync(file, 'utf8').matchAll(ASSET_REFERENCE)) {
      for (const name of spellings(match[1])) used.add(name.toLowerCase())
    }
  }
  return used
}

/** 一个引用可能写成原名或编码形式，两种都收下。 */
function spellings(raw) {
  const bare = raw.replace(/[?#].*$/, '')
  const names = [bare]
  try {
    names.push(decodeURIComponent(bare))
  } catch {
    /* 不是合法的百分号编码，按原样算 */
  }
  return names
}

/** assets/ 下的文件名（相对 assets/，含子目录），排序后返回，让 doctor 的输出稳定。 */
function listAssets(base) {
  const names = []
  const walk = (abs, prefix) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(abs, entry.name), rel)
      else names.push(rel)
    }
  }
  walk(base, '')
  return names.sort()
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const workspace = join(dirname(fileURLToPath(import.meta.url)), '..')
  const sites = listSites(workspace)

  if (sites.length === 0) {
    console.error(`kebab doctor：sites/ 下没有找到任何产品原型。`)
    process.exitCode = 1
  } else {
    let total = 0
    for (const { id, dir } of sites) {
      const problems = doctor(dir, loadSite(dir))
      total += problems.length
      if (problems.length === 0) {
        console.log(`  ✓ ${id}：清单与磁盘一致`)
      } else {
        console.log(`  ✗ ${id}：${problems.length} 个问题`)
        for (const problem of problems) console.error(`      [${problem.kind}] ${problem.message}`)
      }
    }
    if (total > 0) process.exitCode = 1
  }
}
