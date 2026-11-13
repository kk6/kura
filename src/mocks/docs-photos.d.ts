// vite.config.ts の docsPhotos が作るモジュール。KURA_DOCS_PHOTOS がないときは null
declare module 'virtual:docs-photos' {
  const photos: { file_name: string; category: string[]; width: number; height: number; url: string }[] | null
  export default photos
}
