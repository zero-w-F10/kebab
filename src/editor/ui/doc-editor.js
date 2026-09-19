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

export async function mountDocEditor({ root, markdown, onUpload, onChange }) {
  const build = async (wirePasteUpload) => {
    const crepe = new Crepe({
      root,
      defaultValue: markdown ?? '',
      features: FEATURES,
      featureConfigs: featureConfigs(onUpload),
    })
    tuneSerialization(crepe)
    crepe.on((listener) => listener.markdownUpdated((_ctx, next) => onChange(next)))
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
    // 序列化会在末尾多留一个空行，统一成「文件以一个换行结尾」
    getMarkdown: () => crepe.getMarkdown().replace(/\n+$/, '\n'),
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
