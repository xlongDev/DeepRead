# B5 批次小结:多角色听书 + 划选翻译 + 繁简提案

对应 `docs/plan-v0.3.md` §B5(≈2 人日)。三个子项全部落地,零协议变更、零新依赖、零迁移。

---

## 5.1 多角色听书 UI 接线

- `tts-plan.ts` 新增 `buildSpeakerPlan(text, roleNames, maxChars?)`:按角色名把章节切成
  「叙述块 / 角色块」,块携带 `speaker`;同角色连续台词合并,超过 `maxChars` 才断开;
  没有角色名时整章退化成叙述者(等于原来的 `splitChapterBlocks`)。
- `TtsDrawer`:语音面板加「叙述者 / 角色 N」页签,每个检出的角色一行(名字 + 配色的
  音色选择器);未单独配置的角色回退叙述者音色。映射随 `deepread.tts.settings`
  持久化(`speakerVoices: Record<string, string>`,逐字段合并旧设置)。
- 三引擎:Edge/云端换 voice 参数(缓存 key 本就含 voice,天然隔离);系统引擎按说话人
  选 `SpeechSynthesisVoice`。
- 播放链路改成按 speaker 块预取/合成,块内字符偏移 → 原文偏移的 1:1 约束沿用
  (块文本仍是原文切片,测试锁住了「互不重叠、覆盖到章末」)。

**偏差**:`reader-core` 的 `splitDialogue → assignSpeakers → buildSpeechSegments` 链
没有直接复用 —— 它产出的是不带原文偏移的 segment,而朗读高亮需要偏移换算;自己切
(测试可证伪)比改造内核链便宜。说话人归属准确率仍未知,需真书抽查(见「未做」)。

## 5.2 划选翻译

- `ai-core/src/translate.ts`:`buildTranslateMessages({ text, targetLang, context })`
  - `parseTranslation`( zod `{ detectedLang, translation, notes? }`,容忍 ``` 围栏)。
    目标语言默认跟着书走:中文书 → English,其余 → 中文;用户选过就记住(localStorage)。
- 选区工具栏加「翻译」按钮 → 弹层流式渲染 + 复制 + 重试;≤2000 字(超出截断并明示)。
- 成本诚实:卡片固定显示「provider · model」与「源语言 xxx」;没配 AI 服务时给说明,
  不给假译文。

## 5.3 繁简转换(提案制)

- `ai-core/src/convert.ts`:`buildConvertMessages(excerpt, 't2s' | 's2t')` +
  `parseConversions` + `applyConversions`。**不做 OpenCC 内嵌**(计划原判,数据表体积),
  转换由当前 AI provider 出 find/replace 提案,逐条对照原文校验锚点后才显示,用户逐条
  勾选,应用时再校验一次唯一性。
- `ai-core/src/anchor.ts`(新):把原先锁在 `ai-repair.ts` 里的锚定管线
  (JSON 抽取、schema、occurrences 校验、id 生成、唯一性应用)提出来共享 —— 校对和
  繁简是同一个「检测-应用分离」框架的两张皮。`ai-repair.ts` 因此瘦身成 prompt + 转发,
  公开 API 与行为不变(它的 8 个单测原样通过)。
- `AiDrawer`:AI 纠错行旁加「繁简转换(繁→简 / 简→繁)」。评审列表诚实标注
  「由当前 AI 提供商(name · model)生成…已逐条对照原文校验」,并写明单次 100 条上限
  (沿用 schema 的 `.max(100)`,长书重复检查即可,每轮消耗一批)。

**偏差**:计划写「`enhance/text-repair.ts` 新提案类型 t2s/s2t」。实际没往里加 ——
`text-repair.ts` 是本地规则管线(硬换行/空格),它的 `RepairRule` 加两个没有本地检测器
的规则类型,只会造出永远为 0 的死分支;AI 生成的 find/replace 提案天然属于
`ai-repair`/`convert` 这条锚定管线(评审 UI 也已在 AiDrawer)。能力按计划交付,落点
按现有代码形状走。

---

## 测试

- `tts-plan.test.ts` +4 例:角色单独成块、块文本 1:1 原文切片、无角色名退化、
  同角色合并/超限断开。
- `TtsDrawer.test.tsx` +2 例:多角色对话时按说话人换 voice(叙述音色不被顶掉)、
  语音面板出现角色页签。
- `translate.test.ts`(5.2)与 `convert.test.ts`(5.3)覆盖 prompt 契约 / 解析 /
  应用;`ReaderScreen.test.tsx` +2 例翻译流式渲染与无服务时的诚实报错。

## 未做(如实标注)

- **真书验证未执行**:多角色归属准确率、翻译/繁简在真实长文上的质量、改音色后
  缓存 key 隔离,都需要真书会话 + WebDAV 双端确认。
- 繁简转换只覆盖正文前 6000 字/次、100 条提案/次(与 AI 校对同边界),UI 已明示。
