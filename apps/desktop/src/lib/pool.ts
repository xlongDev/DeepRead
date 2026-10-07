/**
 * 有界并发 map:结果按输入顺序返回。
 *
 * 书架封面/元数据提取这类本地 IO(读文件、解 zip、渲染 PDF 首页)逐本串行
 * 太慢,无界 `Promise.all` 又会内存尖峰 —— 小池子刚好。比引 p-limit 少一个
 * 依赖(ADR-0001 依赖纪律)。
 *
 * 刻意是纯原语:任一任务抛出即整体拒绝,不做吞错;每本各自兜底的策略归
 * 调用方(见 LibraryScreen 的封面/元数据管线)。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(0, Math.min(limit, items.length)) }, async () => {
    // 工作队列模式:下一个下标靠自增领取,慢任务不阻塞别的工人。
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await task(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}
