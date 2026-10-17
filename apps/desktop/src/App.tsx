import { useEffect, useState } from 'react'
import type { AppInfo } from '@deepread/shared'
import { invokeCommand } from './lib/ipc'
import { classifyFile, type OpenedBook } from './lib/book-import'
import { LibraryScreen } from './features/library/LibraryScreen'
import { ReaderScreen } from './features/reader/ReaderScreen'

export function App() {
  const [backend, setBackend] = useState<AppInfo | null>(null)
  const [book, setBook] = useState<OpenedBook | null>(null)
  /** 阅读器隐藏而非卸载:TTS 还在播时退到书架,听书跨屏继续。 */
  const [readerHidden, setReaderHidden] = useState(false)

  useEffect(() => {
    let cancelled = false
    invokeCommand('app.info', undefined)
      .then((info) => {
        if (!cancelled) setBackend(info)
      })
      .catch(() => {
        // The library works without the backend; the footer shows 本地模式.
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Dev-only test affordance: ?open=/fixtures/<file> opens a bundled fixture
  // so browser E2E can drive the reader without a file chooser. Tree-shaken
  // from production builds (import.meta.env.DEV).
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const fixture = new URLSearchParams(window.location.search).get('open')
    if (!fixture) return
    void (async () => {
      const response = await fetch(fixture)
      const blob = await response.blob()
      const name = decodeURIComponent(fixture.split('/').pop() ?? 'book')
      const file = new File([blob], name)
      const classified = classifyFile(file)
      if ('kind' in classified) return
      const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      const hashHex = Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      setBook({
        bookId: hashHex,
        format: classified.format,
        hash: hashHex,
        name,
        url: fixture,
      })
    })()
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once per mount
  }, [])

  // 从书架开书:显示阅读器;若上一本还藏在后面听书,连书带播放一起换掉。
  const openBook = (next: OpenedBook): void => {
    setBook(next)
    setReaderHidden(false)
  }

  // 返回书架:TTS 在播(含暂停)→ 隐藏阅读器保留播放;否则卸载收内存。
  // # ponytail: 隐藏期间整本书的 iframe 仍驻留内存(数十 MB 量级),
  //   换来的是听书跨屏连读 —— 若以后要省内存,在章末停播即可。
  const backToLibrary = (ttsPlaying: boolean): void => {
    if (ttsPlaying) setReaderHidden(true)
    else setBook(null)
  }

  return book === null ? (
    <LibraryScreen onOpenBook={openBook} backend={backend} />
  ) : (
    <div hidden={readerHidden}>
      <ReaderScreen
        key={book.bookId}
        book={book}
        onBack={backToLibrary}
        hidden={readerHidden}
        onRequestShow={() => setReaderHidden(false)}
      />
    </div>
  )
}
