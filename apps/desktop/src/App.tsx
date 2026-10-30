import { useEffect, useState } from 'react'
import { classifyFile, sha256Hex, type OpenedBook } from './lib/book-import'
import { LibraryScreen } from './features/library/LibraryScreen'
import { ReaderScreen } from './features/reader/ReaderScreen'
import { ParallelReader } from './features/reader/ParallelReader'

export function App() {
  const [book, setBook] = useState<OpenedBook | null>(null)
  /** 并排阅读的第二本。null = 单本阅读;非 null 时 `book` 是左栏。 */
  const [parallel, setParallel] = useState<OpenedBook | null>(null)
  /** 阅读器隐藏而非卸载:TTS 还在播时退到书架,听书跨屏继续。 */
  const [readerHidden, setReaderHidden] = useState(false)

  // Dev-only test affordance: ?open=/fixtures/<file> opens a bundled fixture so
  // browser E2E can drive the reader without a file chooser; adding
  // &parallel=/fixtures/<file> opens the second one side by side. Tree-shaken
  // from production builds (import.meta.env.DEV).
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const params = new URLSearchParams(window.location.search)
    const fixture = params.get('open')
    if (!fixture) return
    void (async () => {
      const load = async (path: string): Promise<OpenedBook | null> => {
        const response = await fetch(path)
        const blob = await response.blob()
        const name = decodeURIComponent(path.split('/').pop() ?? 'book')
        const file = new File([blob], name)
        const classified = classifyFile(file)
        if ('kind' in classified) return null
        const hash = await sha256Hex(file)
        return { bookId: hash, format: classified.format, hash, name, url: path }
      }
      const first = await load(fixture)
      if (first === null) return
      const secondPath = params.get('parallel')
      const second = secondPath === null ? null : await load(secondPath)
      setBook(first)
      setParallel(second)
    })()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once per mount
  }, [])

  // 从书架开书:显示阅读器;若上一本还藏在后面听书,连书带播放一起换掉。
  // 单本开书要把并排收起 —— 否则新选的书会顶掉左栏、右边还留着上一本。
  const openBook = (next: OpenedBook): void => {
    setBook(next)
    setParallel(null)
    setReaderHidden(false)
  }

  /** 并排打开两本(书架批量选两本 / 阅读中点「对照阅读」再选一本)。 */
  const openParallel = (primary: OpenedBook, secondary: OpenedBook): void => {
    setBook(primary)
    setParallel(secondary)
    setReaderHidden(false)
  }

  // 返回书架:TTS 在播(含暂停)→ 隐藏阅读器保留播放;否则卸载收内存。
  // # ponytail: 隐藏期间整本书的 iframe 仍驻留内存(数十 MB 量级),
  //   换来的是听书跨屏连读 —— 若以后要省内存,在章末停播即可。
  const backToLibrary = (ttsPlaying: boolean): void => {
    if (ttsPlaying) setReaderHidden(true)
    else {
      setBook(null)
      setParallel(null)
    }
  }

  // 书架与阅读器是叠加关系而不是二选一:听书还在播时退到书架,阅读器只是
  // 隐藏(iframe + 播放引擎继续活着),书架必须同时在场 —— 只渲染那个
  // `hidden` 的阅读器,窗口里就一层内容都没有,深色主题下就是「黑屏」。
  return (
    <>
      {(book === null || readerHidden) && (
        <LibraryScreen onOpenBook={openBook} onOpenParallel={openParallel} />
      )}
      {book !== null && (
        <div hidden={readerHidden}>
          {parallel === null ? (
            <ReaderScreen
              key={book.bookId}
              book={book}
              onBack={backToLibrary}
              hidden={readerHidden}
              onRequestShow={() => setReaderHidden(false)}
              onOpenParallel={(other) => openParallel(book, other)}
            />
          ) : (
            <ParallelReader
              key={`${book.bookId}+${parallel.bookId}`}
              primary={book}
              secondary={parallel}
              hidden={readerHidden}
              onBack={backToLibrary}
              onRequestShow={() => setReaderHidden(false)}
              onExit={(keep) => {
                setBook(keep)
                setParallel(null)
              }}
            />
          )}
        </div>
      )}
    </>
  )
}
