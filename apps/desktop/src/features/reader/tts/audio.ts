/**
 * Read-aloud 的音频上下文:整个应用一个,两个 clip 引擎(edge / cloud)共用。
 *
 * 它不住在 `createClipEngine` 里,是因为**解锁必须发生在起播的那次点击里**:
 * WebKit(Safari / WKWebView —— Tauri macOS 的引擎)只认用户手势内创建或恢复的
 * AudioContext;手势之外 `resume()` 被静默拦截,源排在挂起的上下文上照常
 * `start()`,结果是「界面说在播、喇叭没声、还没有任何报错」,读者能做的只有
 * 再点一次播放(暂停再继续,那次 resume 在手势里)才听得见。
 *
 * 而首个 clip 的合成在两次 await 之后(章节文本 + 供应商往返),手势早过期了
 * —— 所以起播的点击处(`ReaderScreen.speakSelection` / `TtsDrawer.play`)先在
 * 这里把上下文建好并恢复,引擎随后在 `start()` 里拿到的是一个已经在跑的上下文。
 *
 * 一个上下文也是 Web Audio 的惯例:多个上下文会被浏览器节流。
 */

let shared: AudioContext | null = null

/** 在用的上下文,第一次用时创建。 */
export function ttsAudio(): AudioContext {
  shared ??= new AudioContext()
  return shared
}

/** 已存在的上下文;没有就回 null —— 绝不为「问一声」而创建(读状态不该
 *  唤醒一个上下文)。 */
export function existingTtsAudio(): AudioContext | null {
  return shared
}

/**
 * 在手势里解锁播放。起播的点击/按键处理函数同步调用:WebKit 只在这种时候
 * 批准创建与恢复。幂等 —— 已经在跑的上下文不动。
 */
export function primeTtsAudio(): void {
  try {
    const context = ttsAudio()
    if (context.state !== 'running') void context.resume()
  } catch {
    // 这个环境没有 Web Audio:等引擎真去播的时候再报错,这里不抢戏。
  }
}

/**
 * 会话真正结束(× / 定时 / 章末不连读)时挂起上下文省电。恢复留给下一次
 * 起播点击里的 {@link primeTtsAudio} —— 挂在别处意味着下一次起播要么再点
 * 一次才有声,要么永远没声(WebKit 不认手势外的 resume)。
 */
export function suspendTtsAudio(): void {
  const context = shared
  if (context?.state === 'running') void context.suspend()
}

/** @internal 测试替身重置:每个用例都从「没有上下文」开始。 */
export function resetSharedAudioForTests(): void {
  shared = null
}
