import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * 测试脚手架：每个用例一个临时工作区，跑完就删。
 * 绝不碰仓库里的 sites/ —— 那是使用者的内容。
 *
 * 跑法就是 npm test（等价于 node --test --test-isolation=none）。
 * 之所以关掉默认的文件级进程隔离：受限环境里不允许 spawn 子进程，
 * 而同进程模式在普通环境下一样跑得通。
 */

export function makeWorkspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kebab-test-'))
  mkdirSync(join(dir, 'sites'), { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 写文件（自动建父目录），路径相对工作区。 */
export function write(workspace, rel, text) {
  const file = join(workspace, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
  return file
}

/** 一个最小可用的产品原型：一个模块，一个 doc 页，一个 proto 页，磁盘各就各位。 */
export function makeSite(workspace, id = 'demo', patch = (site) => site) {
  const site = patch({
    site: { title: '示例产品原型', subtitle: '测试用' },
    modules: [
      {
        id: 'login',
        title: '登录与注册',
        prefix: 'LO',
        pages: [
          { id: 'login-doc', code: 'LO-01', type: 'doc', title: '登录页改版说明' },
          { id: 'login-proto', code: 'LO-02', type: 'proto', title: '新版登录页原型' },
        ],
      },
    ],
  })

  write(workspace, `sites/${id}/site.json`, `${JSON.stringify(site, null, 2)}\n`)
  write(workspace, `sites/${id}/pages/login-doc.md`, '## 调整背景\n\n正文\n')
  write(workspace, `sites/${id}/prototypes/login-proto/index.html`, '<!doctype html><p>proto</p>')
  return { id, dir: join(workspace, 'sites', id), site }
}

/** 一张 1x1 的 PNG，用作上传与搬运测试的素材。 */
export const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGQAAAAASUVORK5CYII=',
  'base64',
)

export const tinyPngBase64 = tinyPng.toString('base64')
