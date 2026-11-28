import { Marked, type Tokens } from 'marked'

// 見出しのアンカー。ガイドの目次は GitHub の書き方（docs/user-guide.md を GitHub で読むときと同じ）で書いてある
export function slug(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-')
}

// docs/user-guide.md を HTML にする（NFR-14）。images はビルドで入れた画像の、docs/images/ からの道筋と URL
export function renderGuide(markdown: string, images: Record<string, string>) {
  const urls = new Map(Object.entries(images).map(([path, url]) => [path.split('/').pop()!, url]))
  const used = new Map<string, number>()
  const marked = new Marked({
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const base = slug(this.parser.parseInline(tokens, this.parser.textRenderer))
        const n = used.get(base) ?? 0
        used.set(base, n + 1)
        return `<h${depth} id="${n ? `${base}-${n}` : base}">${this.parser.parseInline(tokens)}</h${depth}>\n`
      },
      image({ href, text }: Tokens.Image) {
        const src = href.startsWith('images/') ? (urls.get(href.slice('images/'.length)) ?? href) : href
        return `<img src="${src}" alt="${text}">`
      },
    },
  })
  return marked.parse(markdown, { async: false })
}
