/**
 * TXT 章节规则编辑器(spec §15, B7.2)。
 *
 * 纪律:「保存前强制预览」—— 预览区常驻,每条规则的命中数与非法状态都在保存前
 * 摆出来;任何一条 pattern 编译不过或有回溯风险,保存按钮就按不下去。AI 推断的
 * 候选规则也进这同一套流程(以草稿身份出现,用户审核后才落库)。
 *
 * 规则是纯数据:读写走 `lib/chapter-rules.ts`(桌面端 app_settings KV,浏览器端
 * localStorage),合并/匹配/预览的全部逻辑在 ai-core,这里只做编排。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trash } from '@phosphor-icons/react'
import {
  previewChapterRules,
  validateChapterPattern,
  type ChapterRule,
  type ChapterRuleCandidate,
} from '@deepread/ai-core'
import { toAppError } from '@deepread/shared'
import { loadChapterRules, saveChapterRules } from '../../lib/chapter-rules'

export interface ChapterRulesPanelProps {
  /** 书开头若干行(非空),预览在高亮它们上面跑。 */
  readonly sampleLines: readonly string[]
  /** AI 推断候选;null = 当前没有可用的 AI 服务。 */
  readonly onInferCandidates: (() => Promise<readonly ChapterRuleCandidate[]>) | null
  /** 保存并生效:调用方负责重建章节与提示。 */
  readonly onApply: (rules: readonly ChapterRule[]) => Promise<void>
  /** 旧版 per-book 自定义正则(若有):给一键导入,不静默丢弃。 */
  readonly legacyPattern?: string
}

const newRuleId = (): string => `rule-${Math.random().toString(36).slice(2, 10)}`

export function ChapterRulesPanel({
  sampleLines,
  onInferCandidates,
  onApply,
  legacyPattern,
}: ChapterRulesPanelProps) {
  const [rules, setRules] = useState<readonly ChapterRule[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<readonly ChapterRuleCandidate[] | null>(null)

  useEffect(() => {
    let cancelled = false
    loadChapterRules()
      .then((loaded) => {
        if (!cancelled) setRules(loaded)
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage(toAppError(error).message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const patch = useCallback((id: string, changes: Partial<ChapterRule>): void => {
    setRules((current) =>
      current === null
        ? current
        : current.map((rule) => (rule.id === id ? { ...rule, ...changes } : rule)),
    )
  }, [])

  const addRule = useCallback((): void => {
    setRules((current) => [
      ...(current ?? []),
      { id: newRuleId(), name: '', pattern: '', priority: 10, enabled: true },
    ])
  }, [])

  const removeRule = useCallback((id: string): void => {
    setRules((current) => (current === null ? current : current.filter((rule) => rule.id !== id)))
  }, [])

  const inferCandidates = useCallback(async (): Promise<void> => {
    if (onInferCandidates === null) return
    setBusy(true)
    setMessage(null)
    try {
      setCandidates(await onInferCandidates())
    } catch (error) {
      setMessage(toAppError(error).message)
    } finally {
      setBusy(false)
    }
  }, [onInferCandidates])

  /** 候选只是草稿:进列表、过预览,不直接落库。 */
  const acceptCandidate = useCallback((candidate: ChapterRuleCandidate): void => {
    setRules((current) => [
      ...(current ?? []),
      {
        id: newRuleId(),
        name: candidate.name,
        pattern: candidate.pattern,
        priority: candidate.priority,
        enabled: true,
      },
    ])
    setCandidates((current) => current?.filter((item) => item !== candidate) ?? null)
  }, [])

  const importLegacy = useCallback((): void => {
    if (legacyPattern === undefined || legacyPattern.trim() === '') return
    setRules((current) => [
      ...(current ?? []),
      {
        id: newRuleId(),
        name: '旧版自定义正则',
        pattern: legacyPattern.trim(),
        priority: 10,
        enabled: true,
      },
    ])
  }, [legacyPattern])

  // 预览常驻:任何编辑都立刻反映到命中数上,保存前看得见后果。
  const preview = useMemo(
    () => (rules === null ? [] : previewChapterRules(sampleLines, rules)),
    [rules, sampleLines],
  )
  const claimedLines = useMemo(() => {
    const map = new Map<number, string>()
    for (const entry of preview) {
      for (const hit of entry.hits) map.set(hit.lineIndex, entry.rule.name)
    }
    return map
  }, [preview])
  const invalidCount = preview.filter((entry) => entry.error !== null).length

  const save = useCallback(async (): Promise<void> => {
    if (rules === null || invalidCount > 0) return
    setBusy(true)
    setMessage(null)
    try {
      const saved = await saveChapterRules(rules)
      setRules(saved)
      await onApply(saved)
      setMessage('已保存并重建章节。')
    } catch (error) {
      setMessage(toAppError(error).message)
    } finally {
      setBusy(false)
    }
  }, [invalidCount, onApply, rules])

  if (rules === null) {
    return <p className="lookup-empty">正在读取章节规则…</p>
  }

  return (
    <div className="chapter-rules">
      <div className="settings-row">
        <span className="settings-label">章节规则({rules.length})</span>
        <div className="segmented">
          <button type="button" onClick={addRule} disabled={busy}>
            新增规则
          </button>
          <button
            type="button"
            onClick={() => void inferCandidates()}
            disabled={busy || onInferCandidates === null}
            title={
              onInferCandidates === null ? '需要先在 AI 助手里配置服务' : '从书开头推断章节格式'
            }
          >
            {busy ? '推断中…' : 'AI 推断'}
          </button>
        </div>
      </div>
      {legacyPattern !== undefined && legacyPattern.trim() !== '' && (
        <div className="settings-row">
          <span className="settings-label">检测到旧版自定义正则</span>
          <div className="segmented">
            <button type="button" onClick={importLegacy} disabled={busy}>
              导入为规则
            </button>
          </div>
        </div>
      )}
      {rules.map((rule) => {
        const error = validateChapterPattern(rule.pattern)
        return (
          <div key={rule.id} className="chapter-rule-row">
            <input
              className="ai-input"
              placeholder="规则名(如:第 N 卷)"
              value={rule.name}
              onChange={(event) => patch(rule.id, { name: event.target.value })}
            />
            <input
              className="ai-input"
              placeholder="正则,如 ^第.+卷"
              value={rule.pattern}
              onChange={(event) => patch(rule.id, { pattern: event.target.value })}
            />
            <input
              className="chapter-rule-priority"
              type="number"
              title="优先级:越大越先认领一行(内置规则是 0)"
              value={rule.priority}
              onChange={(event) => patch(rule.id, { priority: Number(event.target.value) })}
            />
            <label className="chapter-rule-enabled">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(event) => patch(rule.id, { enabled: event.target.checked })}
              />
              启用
            </label>
            <button
              type="button"
              className="chrome-button"
              onClick={() => removeRule(rule.id)}
              title="删除这条规则"
            >
              <Trash size={14} weight="regular" aria-hidden />
            </button>
            {error !== null && <p className="chapter-rule-error">{error}</p>}
          </div>
        )
      })}

      {candidates !== null && candidates.length > 0 && (
        <div className="chapter-rule-candidates">
          <p className="settings-label">AI 候选(审核后点「采用」才进列表)</p>
          {candidates.map((candidate) => (
            <div key={candidate.pattern} className="chapter-rule-candidate">
              <span>
                <strong>{candidate.name}</strong> <code>{candidate.pattern}</code>(优先级{' '}
                {candidate.priority})
              </span>
              <button type="button" onClick={() => acceptCandidate(candidate)} disabled={busy}>
                采用
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 强制预览:每条规则命中哪些行、内置规则兜底情况,保存前全部摆出来。 */}
      <div className="chapter-rule-preview" aria-label="规则预览">
        <p className="settings-label">
          预览(书开头 {sampleLines.length} 行)· 共命中 {claimedLines.size} 行
        </p>
        {preview.map((entry) => (
          <p key={entry.rule.id} className="chapter-rule-stat">
            {entry.rule.name}(优先级 {entry.rule.priority})
            {entry.rule.id === 'built-in' ? ' · 内置' : ''}:
            {entry.error !== null ? ` ${entry.error}` : ` 命中 ${entry.hits.length} 行`}
          </p>
        ))}
        <div className="chapter-rule-sample">
          {sampleLines.map((line, index) => {
            const claim = claimedLines.get(index)
            return (
              <p key={`${index}-${line}`} className={claim === undefined ? '' : 'is-hit'}>
                {claim !== undefined && <span className="chapter-rule-claim">[{claim}] </span>}
                {line}
              </p>
            )
          })}
        </div>
      </div>

      <div className="segmented">
        <button type="button" onClick={() => void save()} disabled={busy || invalidCount > 0}>
          保存并重建
        </button>
      </div>
      {invalidCount > 0 && (
        <p className="chapter-rule-error">有 {invalidCount} 条规则不合法,修好才能保存。</p>
      )}
      {message !== null && <p className="ai-privacy">{message}</p>}
    </div>
  )
}
