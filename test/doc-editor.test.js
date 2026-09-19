import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mountEditor } from './dom.js'

/**
 * 编辑器不许改写人工写法。
 *
 * 这条不变量是踩过坑才补上的：Crepe 的 ImageBlock 会把 ![说明](…) 的 alt 换成
 * ![1.00](…)、还会在图片前后塞 <br />；remark-stringify 默认把列表写成 `*` ——
 * 于是「打开一下再保存」就能把源文件改得面目全非，SVN diff 全是噪音。
 */
const SAMPLE = [
  '开头一段。',
  '',
  '![改版后的登录页](assets/login-after.svg)',
  '',
  '## 调整背景',
  '',
  '正文，含 `行内代码` 与 **加粗**。',
  '',
  '### 细一点',
  '',
  '更深一层。',
  '',
  '## 待确认',
  '',
  '- 甲',
  '- 乙',
  '  - 乙一',
  '',
  '1. 有序一',
  '2. 有序二',
  '',
  '> 引用一行',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
].join('\n')

test('打开再取回：逐字节一致', async (t) => {
  const handle = await mountEditor(t, SAMPLE)
  assert.equal(handle.getMarkdown(), SAMPLE)
})

test('图片 alt、列表符号、末尾换行都不被改写', async (t) => {
  const markdown = (await mountEditor(t, SAMPLE)).getMarkdown()

  assert.ok(markdown.includes('![改版后的登录页](assets/login-after.svg)'), '图片 alt 被换掉了')
  assert.ok(!markdown.includes('![1.00]'), '图片 alt 被编号顶掉了')
  assert.ok(!markdown.includes('<br />'), '凭空多了 <br />')
  assert.ok(markdown.includes('- 甲'), '列表符号被改成别的了')
  assert.ok(markdown.includes('  - 乙一'), '嵌套列表被打平了')
  assert.ok(markdown.includes('1. 有序一'), '有序列表被改写了')
  assert.ok(markdown.endsWith('\n'), '末尾要有一个换行')
  assert.ok(!markdown.endsWith('\n\n'), '末尾不该多出空行')
})

test('再灌回去也不会漂移（保存两次与保存一次等价）', async (t) => {
  const handle = await mountEditor(t, SAMPLE)
  const first = handle.getMarkdown()

  handle.setMarkdown(first)
  assert.equal(handle.getMarkdown(), first)
})
