import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { checkPrototype } from '../src/import-check.js'
import { makeWorkspace, write } from './helpers.js'

/** 把一组文件铺成一个原型目录，返回它的绝对路径。 */
function prototype(t, files) {
  const workspace = makeWorkspace(t)
  for (const [rel, text] of Object.entries(files)) write(workspace, `proto/${rel}`, text)
  return join(workspace, 'proto')
}

const kinds = (problems) => problems.map((problem) => problem.kind)

test('module script 被拦下，并带处理建议', (t) => {
  const dir = prototype(t, {
    'index.html': '<script type="module" src="app.js"></script>',
    'app.js': 'export const a = 1',
  })
  const problems = checkPrototype(dir)
  assert.deepEqual(kinds(problems), ['module-script'])
  assert.ok(problems[0].hint, '每个问题都要给一句怎么办')
})

test('fetch 与 XMLHttpRequest 被拦下', (t) => {
  assert.deepEqual(kinds(checkPrototype(prototype(t, { 'app.js': 'fetch("./data.json")' }))), ['local-fetch'])
  assert.deepEqual(kinds(checkPrototype(prototype(t, { 'app.js': 'new XMLHttpRequest()' }))), ['local-fetch'])
})

test('公网引用被拦下：HTML 属性、协议相对、CSS 的 url()', (t) => {
  const dir = prototype(t, {
    'index.html': '<img src="https://cdn.example.com/a.png"><link href="//cdn.example.com/b.css">',
    'style.css': '.a{background:url(https://cdn.example.com/c.png)}',
  })
  assert.deepEqual(kinds(checkPrototype(dir)), ['remote-asset', 'remote-asset'])
})

test('引用了却没有的本地文件被拦下，路径按引用文件所在目录解析', (t) => {
  const dir = prototype(t, {
    'index.html': '<img src="assets/ok.png"><img src="assets/gone.png">',
    'assets/ok.png': 'x',
    'sub/style.css': '.a{background:url(../assets/ok.png)} .b{background:url(../assets/nope.png)}',
  })

  const problems = checkPrototype(dir).filter((problem) => problem.kind === 'missing-asset')
  assert.equal(problems.length, 2)
  assert.match(problems[0].message, /assets\/gone\.png/)
  assert.match(problems[1].message, /nope\.png/)
  assert.match(problems[1].message, /sub\/style\.css/)
})

test('以 / 开头的路径单列一类（file:// 下会指向磁盘根）', (t) => {
  const dir = prototype(t, { 'index.html': '<img src="/assets/a.png">' })
  assert.deepEqual(kinds(checkPrototype(dir)), ['root-relative'])
})

test('不误报：<a href>、文本里的链接、data:、无引号 url()、带 query 的引用', (t) => {
  const dir = prototype(t, {
    'index.html': [
      '<a href="https://example.com/doc">外链</a>',
      '<a href="not-exist.html">不存在的本地页</a>',
      '<img src="assets/ok.png?v=2">',
      '<img src="data:image/png;base64,AAAA">',
    ].join(''),
    'app.js': [
      'const doc = "https://ant.design/components/button"',
      'const ns = "http://www.w3.org/2000/svg"',
      'doSomething(url(unquoted))',
    ].join('\n'),
    'assets/ok.png': 'x',
  })
  assert.deepEqual(checkPrototype(dir), [])
})

test('没有可扫的文件时没有问题', (t) => {
  assert.deepEqual(checkPrototype(prototype(t, { 'readme.txt': '没有可扫的东西' })), [])
})
