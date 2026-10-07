import { useCallback, useEffect, useState } from 'react'
import { Check, X } from '@phosphor-icons/react'
import { toAppError, type AnnotationRecord, type LearningCard } from '@deepread/shared'
import { INITIAL_SRS_STATE, isDue, scheduleReview, type ReviewGrade } from '@deepread/shared'
import {
  buildFlashcardMessages,
  buildQuizMessages,
  parseFlashcards,
  parseQuiz,
  type GeneratedQuiz,
} from '@deepread/ai-core'
import { invokeCommand } from '../../lib/ipc'
import { runChatOnce } from '../../lib/ai-chat'

const QUIZ_QUESTION_COUNT = 5

type Tab = 'review' | 'generate' | 'mistakes'

interface LearningDrawerProps {
  readonly bookHash: string
  readonly bookTitle: string
  /** User highlights with excerpts, the raw material for flashcards. */
  readonly annotations: readonly AnnotationRecord[]
  /** Plain text of the section currently on screen (quiz material). */
  readonly getChapterText: () => Promise<string>
  readonly onClose: () => void
}

const GRADE_OPTIONS: readonly { readonly grade: ReviewGrade; readonly label: string }[] = [
  { grade: 'again', label: '重来' },
  { grade: 'hard', label: '困难' },
  { grade: 'good', label: '良好' },
  { grade: 'easy', label: '简单' },
]

function formatInterval(days: number): string {
  if (days < 1) return `${Math.max(1, Math.round(days * 1440))} 分钟`
  if (days < 30) return `${Math.round(days)} 天`
  return `${Math.round(days / 30)} 个月`
}

/** One answered quiz question in the UI. */
interface QuizAnswer {
  readonly chosen: number
  readonly correct: boolean
}

export function LearningDrawer({
  bookHash,
  bookTitle,
  annotations,
  getChapterText,
  onClose,
}: LearningDrawerProps) {
  const [tab, setTab] = useState<Tab>('review')
  const [cards, setCards] = useState<readonly LearningCard[]>([])
  const [configId, setConfigId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [reviewIndex, setReviewIndex] = useState(0)
  const [revealed, setRevealed] = useState(false)

  const [quiz, setQuiz] = useState<GeneratedQuiz | null>(null)
  const [answers, setAnswers] = useState<ReadonlyMap<number, QuizAnswer>>(new Map())
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())

  const loadCards = useCallback(async (): Promise<void> => {
    const response = await invokeCommand('cards.list', { bookHash })
    setCards(response.cards)
  }, [bookHash])

  useEffect(() => {
    let cancelled = false
    void invokeCommand('cards.list', { bookHash })
      .then((response) => {
        if (cancelled) return
        setCards(response.cards)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(toAppError(loadError).message)
      })
    void invokeCommand('ai.config.list', undefined)
      .then((response) => {
        if (cancelled) return
        setConfigId(response.providers[0]?.id ?? null)
      })
      .catch(() => {
        // Generation needs a provider; the buttons surface the error on use.
      })
    return () => {
      cancelled = true
    }
  }, [bookHash])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const dueCards = cards.filter((card) => isDue(card.dueAt))
  const reviewCard = dueCards[Math.min(reviewIndex, dueCards.length - 1)]

  const gradeCurrent = async (grade: ReviewGrade): Promise<void> => {
    if (!reviewCard) return
    const { next, dueAt } = scheduleReview(
      {
        ease: reviewCard.ease,
        intervalDays: reviewCard.intervalDays,
        reps: reviewCard.reps,
        lapses: reviewCard.lapses,
      },
      grade,
    )
    setCards((list) =>
      list.map((card) => (card.id === reviewCard.id ? { ...card, ...next, dueAt } : card)),
    )
    setRevealed(false)
    setReviewIndex((index) => index + 1)
    try {
      await invokeCommand('cards.review', { id: reviewCard.id, ...next, dueAt })
    } catch (reviewError) {
      setError(toAppError(reviewError).message)
    }
  }

  const generateFlashcards = async (): Promise<void> => {
    if (!configId) {
      setError('请先在 AI 助手中配置服务,再生成卡片。')
      return
    }
    const material = annotations.filter(
      (annotation) => (annotation.excerpt ?? '').trim().length > 0,
    )
    if (material.length === 0) {
      setError('先在正文里划几处摘录,再来生成卡片。')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const raw = await runChatOnce(
        configId,
        buildFlashcardMessages(
          material.map((annotation) => ({
            excerpt: annotation.excerpt ?? '',
            note: annotation.note ?? undefined,
          })),
          bookTitle,
        ),
      )
      const parsed = parseFlashcards(raw)
      const response = await invokeCommand('cards.add', {
        bookHash,
        cards: parsed.cards.map((card) => ({
          id: crypto.randomUUID(),
          front: card.front,
          back: card.back,
          source: 'highlight' as const,
          dueAt: new Date().toISOString(),
        })),
      })
      await loadCards()
      setNotice(`已生成 ${response.added} 张卡片(重复的自动忽略)。`)
      setTab('review')
      setReviewIndex(0)
    } catch (generateError) {
      setError(toAppError(generateError).message)
    } finally {
      setBusy(false)
    }
  }

  const generateQuiz = async (): Promise<void> => {
    if (!configId) {
      setError('请先在 AI 助手中配置服务,再生成测验。')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const text = (await getChapterText()).trim()
      if (!text) {
        setError('当前章节没有可出题的正文。')
        return
      }
      const raw = await runChatOnce(
        configId,
        buildQuizMessages(bookTitle, text, QUIZ_QUESTION_COUNT),
      )
      setQuiz(parseQuiz(raw))
      setAnswers(new Map())
    } catch (generateError) {
      setError(toAppError(generateError).message)
    } finally {
      setBusy(false)
    }
  }

  const answerQuestion = async (questionIndex: number, chosen: number): Promise<void> => {
    const question = quiz?.questions[questionIndex]
    if (!question || answers.has(questionIndex)) return
    const correct = chosen === question.answer
    setAnswers((map) => new Map(map).set(questionIndex, { chosen, correct }))
    if (correct) return
    // Wrong answers become mistake-book cards (spec Sprint 12), due now.
    const explanation = question.explanation ? `。${question.explanation}` : ''
    try {
      await invokeCommand('cards.add', {
        bookHash,
        cards: [
          {
            id: crypto.randomUUID(),
            front: question.question,
            back: `${question.options[question.answer] ?? ''}${explanation}`,
            source: 'mistake',
            // oxlint 1.86 的 react(purity) 规则把这里判成「render 期间调用非纯
            // 函数」,但 `answerQuestion` 是答题的事件处理器 —— 用户点选项时才
            // 跑,不在 render 里。规则无法静态区分「组件体内定义的函数会不会被
            // render 调用」,所以保守报错。`useCallback` 也救不了:它依赖
            // `answers` 这个 state,每次 render 都变,memo 没有意义。
            // oxlint-disable-next-line react/purity -- 见上,事件处理器而非 render
            dueAt: new Date().toISOString(),
          },
        ],
      })
      await loadCards()
      setNotice('错题已收进错题本。')
    } catch (mistakeError) {
      setError(toAppError(mistakeError).message)
    }
  }

  const resetCard = async (card: LearningCard): Promise<void> => {
    try {
      const dueAt = new Date().toISOString()
      await invokeCommand('cards.review', {
        id: card.id,
        ...INITIAL_SRS_STATE,
        dueAt,
      })
      await loadCards()
    } catch (resetError) {
      setError(toAppError(resetError).message)
    }
  }

  const removeCard = async (id: string): Promise<void> => {
    try {
      await invokeCommand('cards.remove', { id })
      await loadCards()
    } catch (removeError) {
      setError(toAppError(removeError).message)
    }
  }

  const toggleExpanded = (id: string): void => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const mistakeCards = cards.filter((card) => card.source === 'mistake')
  const highlightCount = annotations.filter((a) => (a.excerpt ?? '').trim().length > 0).length

  return (
    <aside className="ai-drawer learning-drawer" aria-label="学习">
      <div className="lookup-head">
        <strong>学习</strong>
        <button type="button" className="chrome-button" onClick={onClose} title="关闭">
          <X size={16} weight="regular" aria-hidden />
        </button>
      </div>

      <div className="ai-drawer-body">
        <div className="segmented learning-tabs">
          <button
            type="button"
            className={tab === 'review' ? 'is-active' : ''}
            onClick={() => setTab('review')}
          >
            复习{dueCards.length > 0 ? ` ${dueCards.length}` : ''}
          </button>
          <button
            type="button"
            className={tab === 'generate' ? 'is-active' : ''}
            onClick={() => setTab('generate')}
          >
            生成
          </button>
          <button
            type="button"
            className={tab === 'mistakes' ? 'is-active' : ''}
            onClick={() => setTab('mistakes')}
          >
            错题本{mistakeCards.length > 0 ? ` ${mistakeCards.length}` : ''}
          </button>
        </div>

        {tab === 'review' && (
          <section className="review-section" aria-label="间隔复习">
            {!reviewCard && (
              <p className="reader-toc-empty">
                {cards.length === 0
                  ? '还没有卡片。去「生成」标签页,从划线或本章内容做几张。'
                  : '今日复习完成,明天再来。'}
              </p>
            )}
            {reviewCard && (
              <>
                <p className="review-progress">
                  {Math.min(reviewIndex + 1, dueCards.length)} / {dueCards.length}
                </p>
                <div className="card-body">
                  <p className="card-front">{reviewCard.front}</p>
                  {revealed && (
                    <p className="card-back">
                      {reviewCard.back}
                      <span className="card-source">
                        {reviewCard.source === 'mistake'
                          ? '错题'
                          : reviewCard.source === 'quiz'
                            ? '测验'
                            : '划线'}
                      </span>
                    </p>
                  )}
                </div>
                {!revealed ? (
                  <button
                    type="button"
                    className="reader-error-button"
                    onClick={() => setRevealed(true)}
                  >
                    显示答案
                  </button>
                ) : (
                  <div className="grade-row">
                    {GRADE_OPTIONS.map((option) => {
                      const preview = scheduleReview(
                        {
                          ease: reviewCard.ease,
                          intervalDays: reviewCard.intervalDays,
                          reps: reviewCard.reps,
                          lapses: reviewCard.lapses,
                        },
                        option.grade,
                      )
                      return (
                        <button
                          key={option.grade}
                          type="button"
                          className={option.grade === 'again' ? 'is-again' : ''}
                          onClick={() => void gradeCurrent(option.grade)}
                        >
                          {option.label}
                          <small>{formatInterval(preview.next.intervalDays)}</small>
                        </button>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {tab === 'generate' && (
          <section aria-label="生成学习内容">
            <div className="settings-row">
              <span className="settings-label">从划线生成闪卡({highlightCount})</span>
              <div className="segmented">
                <button type="button" disabled={busy} onClick={() => void generateFlashcards()}>
                  {busy ? '生成中…' : '生成'}
                </button>
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-label">本章小测({QUIZ_QUESTION_COUNT} 题)</span>
              <div className="segmented">
                <button type="button" disabled={busy} onClick={() => void generateQuiz()}>
                  {busy ? '出题中…' : '出题'}
                </button>
              </div>
            </div>
            {quiz?.questions.map((question, questionIndex) => {
              const answer = answers.get(questionIndex)
              return (
                <div key={questionIndex} className="quiz-item">
                  <p className="quiz-question">{question.question}</p>
                  <div className="quiz-options">
                    {question.options.map((option, optionIndex) => {
                      const isChosen = answer?.chosen === optionIndex
                      const isAnswer = question.answer === optionIndex
                      const state =
                        answer === undefined
                          ? ''
                          : isAnswer
                            ? 'is-correct'
                            : isChosen
                              ? 'is-wrong'
                              : ''
                      return (
                        <button
                          key={optionIndex}
                          type="button"
                          className={`quiz-option ${state}`}
                          disabled={answer !== undefined}
                          onClick={() => void answerQuestion(questionIndex, optionIndex)}
                        >
                          {isAnswer && answer !== undefined && <Check size={12} aria-hidden />}
                          {option}
                        </button>
                      )
                    })}
                  </div>
                  {answer !== undefined && !answer.correct && question.explanation && (
                    <p className="quiz-explanation">{question.explanation}</p>
                  )}
                </div>
              )
            })}
          </section>
        )}

        {tab === 'mistakes' && (
          <section aria-label="错题本">
            {mistakeCards.length === 0 && (
              <p className="reader-toc-empty">暂无错题。答错的小测题会自动收进这里。</p>
            )}
            {mistakeCards.map((card) => (
              <div key={card.id} className="mistake-item">
                <button
                  type="button"
                  className="mistake-front"
                  onClick={() => toggleExpanded(card.id)}
                  title="展开/收起答案"
                >
                  {card.front}
                </button>
                {expandedIds.has(card.id) && <p className="card-back">{card.back}</p>}
                <div className="mistake-actions">
                  <button
                    type="button"
                    onClick={() => void resetCard(card)}
                    title="重新加入今日复习"
                  >
                    重置进度
                  </button>
                  <button type="button" onClick={() => void removeCard(card.id)} title="删除错题">
                    删除
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {notice !== null && <p className="ai-privacy">{notice}</p>}
        {error !== null && (
          <p className="ai-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </aside>
  )
}
