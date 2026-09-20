import { Crepe } from '@milkdown/crepe'
import { remarkStringifyOptionsCtx } from '@milkdown/kit/core'
import { replaceAll } from '@milkdown/kit/utils'
import { uploadConfig } from '@milkdown/kit/plugin/upload'

// 主题 CSS 由 main.js 引 —— 这个文件保持纯 JS，node 才能直接 import 它来测

/**
 * doc 页的块式编辑器，见 docs/adr/0004。
 *
 * 磁盘上仍然是纯 Markdown：编辑器只管显示与交互，getMarkdown() 的返回值直接写
 * pages/<id>.md。图片一律经 onUpload 落到 assets/，不内联 base64 ——
 * 否则一张截图就能让正文文件膨胀到几兆，而且 SVN diff 会变成一团乱码。
 */

// 用不到公式与 AI；顺带避开「空语言代码块让 getMarkdown() 抛错」那个已知问题
const FEATURES = {
  [Crepe.Feature.Latex]: false,
  [Crepe.Feature.AI]: false,
  [Crepe.Feature.TopBar]: false,
  // 它的图片块会把 ![说明](…) 的 alt 改写成 ![1.00](…)、还会在图片前后塞 <br /> ——
  // 源文件不该被这样改写。关掉之后图片退回普通 image 节点，粘贴上传照走 upload 插件。
  [Crepe.Feature.ImageBlock]: false,
}

const featureConfigs = (onUpload) => ({
  [Crepe.Feature.ImageBlock]: {
    onUpload,
    blockOnUpload: onUpload,
    inlineOnUpload: onUpload,
    blockUploadButton: '选图片',
    blockUploadPlaceholderText: '粘贴图片链接，或把截图直接拖进来',
    blockCaptionPlaceholderText: '图注（可选）',
    blockConfirmButton: '确定',
    inlineUploadButton: '选图片',
    inlineUploadPlaceholderText: '粘贴图片链接',
    inlineConfirmButton: '确定',
  },
  [Crepe.Feature.Placeholder]: { text: '正文从 ## 开始写，标题层级会自动变成条目编号' },
})

/**
 * 序列化收尾：末尾统一成一个换行（序列化本身会多留空行）。
 *
 * 收尾必须同时用在两个出口上：getMarkdown() 是落盘要写的字节，onChange 是让外面判断
 * 「有没有改动」的依据。只收前者的话，Crepe 挂载完成后补报的那一次 markdownUpdated
 * 会带着末尾空行送出去，跟刚读进来的正文对不上。
 */
export const finishMarkdown = (text) => (text ?? '').replace(/\n+$/, '\n')

/**
 * 这次回调算不算真的改动：把序列化结果按落盘格式收尾，再跟手里那份逐字比。
 *
 * Crepe 挂载完成后必定补报一次 markdownUpdated，那次的结果与刚读进来的正文只差末尾空行；
 * 不比较就会把「一打开页面」当成「有未保存的改动」，而保存写回去的字节其实一模一样。
 */
export const isRealChange = (current, next) => finishMarkdown(next) !== current

export async function mountDocEditor({ root, markdown, onUpload, onChange }) {
  const build = async (wirePasteUpload) => {
    const crepe = new Crepe({
      root,
      defaultValue: markdown ?? '',
      features: FEATURES,
      featureConfigs: featureConfigs(onUpload),
    })
    tuneSerialization(crepe)
    crepe.on((listener) => listener.markdownUpdated((_ctx, next) => onChange(finishMarkdown(next))))
    if (wirePasteUpload) wirePasteUploader(crepe, onUpload)
    await crepe.create()
    return crepe
  }

  let crepe
  try {
    crepe = await build(true)
  } catch (error) {
    // 这一版 Crepe 没把 upload 插件带进来时，退回文件选择与拖拽这两条路，
    // 编辑器本身仍然可用 —— 不能因为一个附加配置把整页弄坏。
    console.warn('[kebab] 粘贴上传没接上，退回基础上传：', error)
    root.replaceChildren()
    crepe = await build(false)
  }

  return {
    getMarkdown: () => finishMarkdown(crepe.getMarkdown()),
    setMarkdown: (next) => crepe.editor.action(replaceAll(next ?? '', true)),
    destroy: () => crepe.destroy(),
  }
}

/**
 * 让序列化贴近人工写法。remark-stringify 默认把列表符号写成 `*`，
 * 每次保存都会凭空改一行 —— 保存应当只写用户真正改动的地方。
 */
function tuneSerialization(crepe) {
  crepe.editor.config((ctx) => {
    ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet: '-' }))
  })
}

/** 粘贴、拖入编辑器主体的图片也走上传，而不是被内联成 base64。 */
function wirePasteUploader(crepe, onUpload) {
  crepe.editor.config((ctx) => {
    ctx.update(uploadConfig.key, (prev) => ({
      ...prev,
      enableHtmlFileUploader: true,
      uploader: async (files, schema) => {
        const nodes = []
        for (const file of files) {
          if (!file.type?.startsWith('image/')) continue
          const src = await onUpload(file)
          nodes.push(schema.nodes.image.createAndFill({ src, alt: file.name }))
        }
        return nodes
      },
    }))
  })
}
