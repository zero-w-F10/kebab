import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installDom, mountEditor } from './dom.js'

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

test('序列化只差末尾空行时不算改动 —— 挂载后补报的那一次走的就是这里', async () => {
  // 真实故障：Crepe 挂载完成后必定补报一次 markdownUpdated，那次带的是原始序列化结果，
  // 比磁盘上那份多一个末尾空行。外面一律当成改动，于是「一打开页面就提示有未保存的改动」，
  // 而实际保存写回去的字节完全一样。
  //
  // jsdom 里 Milkdown 不发这个事件（挂载、setMarkdown、等多久都不发），所以这里不绕弯，
  // 直接测那个判断本身：收尾之后相等就不算改动。
  installDom()
  const { finishMarkdown, isRealChange } = await import('../src/editor/ui/doc-editor.js')

  assert.equal(finishMarkdown(`${SAMPLE}\n\n\n`), SAMPLE, '末尾空行收成一个换行')
  assert.equal(isRealChange(SAMPLE, `${SAMPLE}\n`), false, '只多一个末尾空行，不算改动')
  assert.equal(isRealChange(SAMPLE, `${SAMPLE}\n\n`), false, '多两个也一样')
  assert.equal(isRealChange(SAMPLE, SAMPLE), false, '逐字相同，不算改动')
  assert.equal(isRealChange(SAMPLE, `${SAMPLE}新增一段。\n`), true, '真加了内容才算改动')
  assert.equal(isRealChange(SAMPLE, SAMPLE.replace('调整背景', '改动背景')), true)
  assert.equal(isRealChange('', finishMarkdown(undefined)), false, '空正文不算改动')
})
