/**
 * scripts/reindex.ts —— 全量重建检索索引（会真的调用向量接口，有少量花费）。
 *
 * 什么时候需要它：换了 embedding 模型 / 改了 dimensions / 改了分片规则。
 * 只是改了文章内容的话，界面上的「重建索引」走的是增量，不必要用这个。
 *
 * 用法：npx tsx scripts/reindex.ts
 */
import { buildIndex, indexStatus } from '../../server/services/vectorstore';

async function main() {
  const t0 = Date.now();
  const r = await buildIndex({ force: true });
  const ms = Date.now() - t0;
  console.log(`重建完成，用时 ${(ms / 1000).toFixed(1)}s`);
  console.log(JSON.stringify(r, null, 2));

  const st = await indexStatus();
  console.log('索引状态：', JSON.stringify(st));
  if (st.withVector !== st.total) {
    console.log(`⚠ 有 ${st.total - st.withVector} 个分片没有向量`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
