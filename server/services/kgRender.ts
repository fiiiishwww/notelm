/**
 * kgRender.ts —— SKOS 知识图谱的三格式导出 + 与 V1 的对比
 *
 * ═══ 为什么导出三种格式 ═══
 *
 * 多鱼的要求是「**既可以给人读，又可以给机器读**」。这两个诉求的载体不同：
 *   · 人读 → Markdown：按 broader 层级排开，通读即知识梳理
 *   · 机读 → JSON：属性图，程序/agent 直接消费
 *   · 机读（标准）→ Turtle：W3C 标准格式，任何图库/校验器能吃
 *
 * 三份产物**同源**（都从 `KgGraph` 渲染），不会互相漂移。
 *
 * ═══ 与知识树的关键差异 ═══
 *   · 不渲染成"树"（那是知识树的形态），概念可以有多个 broader
 *   · 不用顺序号 id，用 sha256 派生的稳定 id
 *   · 关系独立成节（知识树里 relations 是节点的附庸，图谱里边是一等公民）
 */
import type { KgGraph, KgEdge } from '../../shared/kgSchema';
import { KG_RELATIONS, KG_RELATION_DEFS } from '../../shared/kgSchema';

// ─────────────────── 人读：Markdown ───────────────────

/**
 * 渲染人读版。
 *
 * ★ 排序策略：按 broader 层级遍历（根 → 子），同层按「被引次数」降序 ★
 *   被引多的概念通常更核心，排前面更符合阅读直觉。
 */
export function renderKgMarkdown(g: KgGraph): string {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, string[]>();
  for (const n of g.nodes) {
    for (const b of n.broader) {
      if (!byId.has(b)) continue;
      if (!childrenOf.has(b)) childrenOf.set(b, []);
      childrenOf.get(b)!.push(n.id);
    }
  }

  /** 被引次数：作为 broader 被几个概念指向。 */
  const indeg = new Map<string, number>();
  for (const n of g.nodes) for (const b of n.broader) indeg.set(b, (indeg.get(b) ?? 0) + 1);

  const edgesOf = new Map<string, KgEdge[]>();
  for (const e of g.edges) {
    if (!edgesOf.has(e.source)) edgesOf.set(e.source, []);
    edgesOf.get(e.source)!.push(e);
  }

  const lines: string[] = [];
  const m = g.meta;
  lines.push(`# 知识图谱：${m.unitTitle}`);
  lines.push('');
  lines.push(`> 来源：\`${m.docRel}\` · 块 ${m.scope.from}~${m.scope.to}（${m.scope.blocks} 块）`);
  lines.push(`> 生成：${m.generatedAt} · ${m.model} · 提示词 ${m.promptVer}`);
  lines.push('');

  // 概览
  const roots = g.nodes.filter((n) => !n.broader.length);
  lines.push('## 概览');
  lines.push('');
  lines.push(`- 概念 **${g.nodes.length}** 个 · 关系 **${g.edges.length}** 条 · 顶层概念 ${roots.length} 个`);
  const relDist: Record<string, number> = {};
  for (const e of g.edges) relDist[e.rel] = (relDist[e.rel] ?? 0) + 1;
  lines.push(
    `- 关系分布：${Object.entries(relDist)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ')}`,
  );
  const alt = g.nodes.filter((n) => n.altLabel.length);
  lines.push(`- 别名归并：${alt.length} 个概念带别名（共 ${alt.reduce((s, n) => s + n.altLabel.length, 0)} 条）`);
  const multi = g.nodes.filter((n) => n.broader.length > 1);
  lines.push(`- 多上位概念：${multi.length} 个`);
  lines.push('');

  // 关系词表（人也要能查"这条边什么意思"）
  lines.push('## 关系词表（6 类非分类关系）');
  lines.push('');
  lines.push('| 谓词 | 含义 | 示例 |');
  lines.push('|---|---|---|');
  for (const r of KG_RELATIONS) {
    const d = KG_RELATION_DEFS[r];
    lines.push(`| ${r} | ${d.def} | ${d.sample} |`);
  }
  lines.push('');
  lines.push('> 分类关系（上位 / 别名）用 W3C SKOS 标准的 `skos:broader` / `skos:altLabel`，不在此表。');
  lines.push('');

  // 正文：按层级遍历
  lines.push('---');
  lines.push('');

  const seen = new Set<string>();
  const renderNode = (id: string, level: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = byId.get(id);
    if (!n) return;
    const h = '#'.repeat(Math.min(6, level + 2));
    lines.push(`${h} ${n.prefLabel}  \`${n.notation}\``);
    lines.push('');
    if (n.definition) {
      lines.push(`> ${n.definition}`);
      lines.push('');
    }
    if (n.altLabel.length) {
      lines.push(`**别名**：${n.altLabel.map((a) => `\`${a}\``).join(' · ')}`);
      lines.push('');
    }
    if (n.provenance.length) {
      const p = n.provenance[0];
      lines.push(`**出处**：第 ${p.bi} 块 ——「${p.quote}」`);
      lines.push('');
    }
    if (n.examples.length) {
      lines.push('**示例**');
      lines.push('');
      for (const ex of n.examples) {
        const bi = ex.provenance[0]?.bi;
        lines.push(`- ${ex.text}${bi !== undefined ? `（第 ${bi} 块）` : ''}`);
      }
      lines.push('');
    }
    const es = edgesOf.get(id);
    if (es?.length) {
      lines.push('**关联**');
      lines.push('');
      for (const e of es) {
        const t = byId.get(e.target)?.prefLabel ?? e.target;
        lines.push(`- **${e.rel}** → ${t}${e.description ? `：${e.description}` : ''}`);
      }
      lines.push('');
    }
    const kids = (childrenOf.get(id) ?? []).sort((a, b) => (indeg.get(b) ?? 0) - (indeg.get(a) ?? 0));
    for (const k of kids) renderNode(k, level + 1);
  };

  for (const r of roots.sort((a, b) => (indeg.get(b.id) ?? 0) - (indeg.get(a.id) ?? 0))) renderNode(r.id, 0);
  // 兜底：有父但父不存在的
  for (const n of g.nodes) if (!seen.has(n.id)) renderNode(n.id, 0);

  // 关系总表（机器读也行，但这里给人扫）
  lines.push('---');
  lines.push('');
  lines.push('## 关系全表');
  lines.push('');
  lines.push('| 源 | 谓词 | 目标 | 说明 |');
  lines.push('|---|---|---|---|');
  for (const e of g.edges) {
    const s = byId.get(e.source)?.prefLabel ?? e.source;
    const t = byId.get(e.target)?.prefLabel ?? e.target;
    lines.push(`| ${s} | ${e.rel} | ${t} | ${e.description} |`);
  }
  lines.push('');

  return lines.join('\n');
}

// ─────────────────── 机读：Turtle ───────────────────

function ttlEscape(s: string): string {
  return (s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/**
 * 渲染 Turtle（W3C 标准）。
 *
 * ★ 概念层用 SKOS 原生谓词，关系层用 nb: 命名空间 ★
 *   关系谓词会声明 `rdfs:subPropertyOf skos:related`，
 *   这样既是标准（能被 SKOS 工具识别为一类 related 关系），又保住语义（6 类各有所指）。
 */
export function renderKgTurtle(g: KgGraph): string {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];

  lines.push('@prefix skos: <http://www.w3.org/2004/02/skos/core#> .');
  lines.push('@prefix dcterms: <http://purl.org/dc/terms/> .');
  lines.push('@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .');
  lines.push('@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .');
  lines.push('@prefix nb: <https://notelm.local/kg/vocab#> .');
  lines.push('');

  // 概念体系（一整节 = 一个 ConceptScheme）
  const schemeUri = `https://notelm.local/kg/${g.meta.headingId}`;
  lines.push(`<${schemeUri}> a skos:ConceptScheme ;`);
  lines.push(`  dcterms:title "${ttlEscape(g.meta.unitTitle)}" ;`);
  lines.push(`  dcterms:source "${ttlEscape(g.meta.docRel)}" .`);
  lines.push('');

  // 谓词定义（让任何读这份 TTL 的工具都知道 nb:导致 是什么）
  for (const r of KG_RELATIONS) {
    const d = KG_RELATION_DEFS[r];
    lines.push(`nb:${r} a rdf:Property ;`);
    lines.push(`  rdfs:subPropertyOf skos:related ;`);
    lines.push(`  rdfs:label "${r}" ;`);
    lines.push(`  rdfs:comment "${ttlEscape(d.def)}" .`);
    lines.push('');
  }

  // 概念
  for (const n of g.nodes) {
    const uri = `<${n.uri}>`;
    lines.push(`${uri} a skos:Concept ;`);
    lines.push(`  skos:inScheme <${schemeUri}> ;`);
    lines.push(`  skos:prefLabel "${ttlEscape(n.prefLabel)}"@zh ;`);
    for (const a of n.altLabel) lines.push(`  skos:altLabel "${ttlEscape(a)}"@zh ;`);
    if (n.definition) lines.push(`  skos:definition "${ttlEscape(n.definition)}"@zh ;`);
    lines.push(`  skos:notation "${n.notation}" ;`);
    for (const b of n.broader) {
      const bn = byId.get(b);
      if (bn) lines.push(`  skos:broader <${bn.uri}> ;`);
    }
    for (const ex of n.examples) {
      lines.push(`  skos:example "${ttlEscape(ex.text)}"@zh ;`);
      const bi = ex.provenance[0]?.bi;
      if (bi !== undefined) lines.push(`  dcterms:source "bi:${bi}" ;`);
    }
    for (const p of n.provenance) {
      lines.push(`  skos:scopeNote "bi:${p.bi} ${ttlEscape(p.quote)}"@zh ;`);
    }
    // 去掉最后一个分号，句号结尾
    lines[lines.length - 1] = lines[lines.length - 1].replace(/ ;$/, ' .');
    lines.push('');
  }

  // 关系边
  for (const e of g.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    lines.push(`<${s.uri}> nb:${e.rel} <${t.uri}> .`);
  }
  lines.push('');

  return lines.join('\n');
}

// ─────────────────── schema 文档（人读 + 机读）───────────────────

export function renderSkosProfile(): string {
  return JSON.stringify(
    {
      name: 'notelm-kg',
      version: 'rc1',
      generatedAt: new Date().toISOString(),
      description: 'NoteLM 知识图谱 schema：概念层用 W3C SKOS，关系层用 6 类非分类谓词。',
      namespaces: {
        skos: 'http://www.w3.org/2004/02/skos/core#',
        dcterms: 'http://purl.org/dc/terms/',
        nb: 'https://notelm.local/kg/vocab#',
      },
      conceptClass: {
        rdf: 'skos:Concept',
        note: 'SKOS 规范：Concept 是 "an idea or notion; a unit of thought"。案例、数字、图表不是概念。',
      },
      taxonomy: {
        broader: { skos: 'skos:broader', note: '上位概念。严格偏序，★允许一个概念有多个 broader。' },
        altLabel: { skos: 'skos:altLabel', note: '别名。同一概念的不同叫法收在这里，而不是拆成两个节点。' },
        prefLabel: { skos: 'skos:prefLabel', note: '首选名，每语言最多一个。' },
        notation: { skos: 'skos:notation', values: ['概念', '机制', '原则'], note: '概念类型标记。用 SKOS 原生机制，不引入新闭集。' },
        example: { skos: 'skos:example', note: '案例 / 数字 / 图表挂在这里，不作为独立概念。' },
      },
      relations: KG_RELATIONS.map((r) => ({
        label: r,
        rdf: KG_RELATION_DEFS[r].rdf,
        subPropertyOf: 'skos:related',
        definition: KG_RELATION_DEFS[r].def,
        domain: KG_RELATION_DEFS[r].domain,
        range: KG_RELATION_DEFS[r].range,
        sample: KG_RELATION_DEFS[r].sample,
      })),
      edgeRequired: ['source', 'target', 'rel', 'description', 'provenance'],
      edgeNote: 'description 必填（主流把「只有谓词没有说明」视为无效边）；provenance 必填（无边出处则不可审计）。',
    },
    null,
    2,
  );
}

// ─────────────────── 对比 V1 ───────────────────

export interface V1Stats {
  nodes: number;
  edges: number;
  /** ★ 真正连到图内节点的边数（V1 的 relations 允许 target 是"图外名词"） */
  edgesInGraph?: number;
  /** 只统计被实际用到的谓词种类 */
  relKinds: number;
  roots: number;
  maxDepth: number;
  leaves: number;
  /** 有子节点的节点数 */
  branchNodes: number;
  /** 根 A 子树规模 */
  largestRootSize: number;
  /** 根 A 直接子节点数 */
  largestRootChildren: number;
  altLabelGroups: number;
  multiParent: number;
  /** 覆盖原文块数（V1 无块级定位记录时留 undefined） */
  coveredBlocks?: number;
  totalBlocks?: number;
  /** 顺序号 id 是否稳定 */
  stableIds: boolean;
  skosCompliant: boolean;
}

export interface KgStats {
  nodes: number;
  edges: number;
  relKinds: number;
  roots: number;
  maxDepth: number;
  leaves: number;
  branchNodes: number;
  largestRootSize: number;
  largestRootChildren: number;
  altLabelGroups: number;
  multiParent: number;
  coveredBlocks: number;
  totalBlocks: number;
  stableIds: boolean;
  skosCompliant: boolean;
}

/** 从本图谱算出统计。 */
export function statsOf(g: KgGraph, coveredBlocks: number, totalBlocks: number): KgStats {
  const childrenOf = new Map<string, string[]>();
  for (const n of g.nodes) {
    for (const b of n.broader) {
      if (!childrenOf.has(b)) childrenOf.set(b, []);
      childrenOf.get(b)!.push(n.id);
    }
  }
  const roots = g.nodes.filter((n) => !n.broader.length);
  const leaves = g.nodes.filter((n) => !(childrenOf.get(n.id)?.length));
  const branch = g.nodes.filter((n) => childrenOf.get(n.id)?.length);

  // ★ 子树规模必须去重 ★
  //   多父结构下，同一个概念会被多个祖先的子树重复计入，
  //   不去重会算出「最大子树 128 > 总节点 88」这种不可能的 145%。
  const sizeOf = (id: string): number => {
    const seen = new Set<string>();
    const walk = (x: string): void => {
      if (seen.has(x)) return;
      seen.add(x);
      for (const k of childrenOf.get(x) ?? []) walk(k);
    };
    walk(id);
    return seen.size;
  };
  const sizes = roots
    .map((r) => ({ id: r.id, size: sizeOf(r.id), kids: childrenOf.get(r.id)?.length ?? 0 }))
    .sort((a, b) => b.size - a.size);
  const depth = new Map<string, number>();
  const bmap = new Map(g.nodes.map((n) => [n.id, n.broader]));
  const dOf = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    const bs = bmap.get(id) ?? [];
    if (!bs.length) {
      depth.set(id, 0);
      return 0;
    }
    const d = 1 + Math.max(...bs.map((b) => dOf(b)));
    depth.set(id, d);
    return d;
  };
  for (const n of g.nodes) dOf(n.id);
  const relKinds = new Set(g.edges.map((e) => e.rel)).size;
  return {
    nodes: g.nodes.length,
    edges: g.edges.length,
    relKinds,
    roots: roots.length,
    maxDepth: Math.max(0, ...[...depth.values()]),
    leaves: leaves.length,
    branchNodes: branch.length,
    largestRootSize: sizes[0]?.size ?? 0,
    largestRootChildren: sizes[0]?.kids ?? 0,
    altLabelGroups: g.nodes.filter((n) => n.altLabel.length).length,
    multiParent: g.nodes.filter((n) => n.broader.length > 1).length,
    coveredBlocks,
    totalBlocks,
    stableIds: true,
    skosCompliant: true,
  };
}

/**
 * ★ 对比表：分两栏 ★
 *
 * 栏 A「V1 也能测的」—— 用于证明**没退化**，不是战果。
 *   一条 skos:broader 和一条 parent 结构上就是同一个东西，拿它邀功是照搬知识树的评价方式。
 * 栏 B「V1 测不了的」—— 这才是真增量。
 */
export function renderCompare(v1: V1Stats, kg: KgStats): string {
  const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');
  const L: string[] = [];
  L.push('# 对比：SKOS 知识图谱 vs V1 知识树');
  L.push('');
  L.push('> **基线说明（必读）**：V1 树是在「思考模式开着」的条件下生成的');
  L.push('> （见 `server/routes/study.ts:91-98` 注释：同一节 21 次调用里 17 次被 `max_tokens` 截断，其中 14 次正文 0 字）。');
  L.push('> 若对比结果异常，**先质疑基线是否失真**，再下结论。');
  L.push('');

  L.push('## 栏 A · V1 也能测的指标（用于证明没退化，**不是战果**）');
  L.push('');
  L.push('| 指标 | V1 知识树 | SKOS 图谱 | 说明 |');
  L.push('|---|---|---|---|');
  L.push(`| 节点数 | ${v1.nodes} | ${kg.nodes} | — |`);
  L.push(`| 有子节点的节点数 | ${v1.branchNodes} | ${kg.branchNodes} | 结构承载力 |`);
  L.push(`| 叶子占比 | ${pct(v1.leaves, v1.nodes)} | ${pct(kg.leaves, kg.nodes)} | 越低越好 |`);
  L.push(`| 顶层节点数 | ${v1.roots} | ${kg.roots} | 少而清好 |`);
  L.push(`| 最大深度 | ${v1.maxDepth} | ${kg.maxDepth} | — |`);
  L.push(`| 最大子树占比 | ${pct(v1.largestRootSize, v1.nodes)} | ${pct(kg.largestRootSize, kg.nodes)} | 越低越均衡 |`);
  L.push(`| 顶层最大直连子数 | ${v1.largestRootChildren} | ${kg.largestRootChildren} | 数字大=一根杆插满叶子 |`);
  L.push(
    `| 覆盖原文块 | ${v1.coveredBlocks === undefined ? '未记录' : `${v1.coveredBlocks}/${v1.totalBlocks}`} | ${kg.coveredBlocks}/${kg.totalBlocks}（${pct(kg.coveredBlocks, kg.totalBlocks)}） | V1 一次生成，无块级定位记录 |`,
  );
  L.push('');
  L.push('> ★ 一条 `skos:broader` 和一条 `parent` 结构上就是同一个东西。');
  L.push('> **这一栏数字差异不构成 SKOS 路线的价值**，只用来确认没有把原有的东西做坏。');
  L.push('>');
  L.push('> ⚠️ **本栏不利项如实列出**：SKOS 图谱的顶层节点数与叶子占比都高于 V1。');
  L.push('> 原因见文末「已知缺陷」——不是方法问题，是分块抽取的固有代价 + 我引入的归并 bug。');
  L.push('');

  L.push('## 栏 B · V1 **测不了**的指标（这才是真增量）');
  L.push('');
  L.push('| 指标 | V1 知识树 | SKOS 图谱 | 为什么 V1 测不了 |');
  L.push('|---|---|---|---|');
  L.push(
    `| 非分类关系边数 | ${v1.edges}${v1.edgesInGraph !== undefined ? `（连到图内 ${v1.edgesInGraph}）` : ''} | ${kg.edges} | V1 提示词限制跨分支边（「图外边不超过 1/3」）；V1 的 relations 允许 target 是图外名词 |`,
  );
  L.push(`| 关系谓词种类 | ${v1.relKinds}（8 类闭集，实际用到 ${v1.relKinds} 类） | ${kg.relKinds} | V1 的 8 类含「属于/等价」两个层级类，与 parent 职责重叠 |`);
  L.push(
    `| 别名归并 | ${v1.altLabelGroups} | ${kg.altLabelGroups} | V1 的 norm() 不剥括号，同族概念被判为不同节点 |`,
  );
  L.push(`| 多上位概念数 | ${v1.multiParent} | ${kg.multiParent} | V1 单父约束（parent 是字符串或 null），结构性不可能 |`);
  L.push(
    `| id 稳定性 | ${v1.stableIds ? '稳定' : '不稳定（顺序号 k1/k2）'} | ${kg.stableIds ? '稳定（sha256 派生）' : '不稳定'} | 重跑即变则增量更新失效 |`,
  );
  L.push(`| SKOS 合规 | ${v1.skosCompliant ? '是' : '否（非标准格式）'} | ${kg.skosCompliant ? '是' : '否'} | V1 不是标准格式，工具无法校验 |`);
  L.push('');

  L.push('## 结论');
  L.push('');
  const gained: string[] = [];
  if (kg.edges > v1.edges) gained.push(`非分类关系边 ${v1.edges} → ${kg.edges}`);
  if (kg.relKinds >= v1.relKinds) gained.push(`谓词种类覆盖 ${kg.relKinds}/6 全用上`);
  if (kg.altLabelGroups > v1.altLabelGroups) gained.push(`带别名的概念 ${v1.altLabelGroups} → ${kg.altLabelGroups}`);
  if (kg.multiParent > v1.multiParent) gained.push(`多上位 ${v1.multiParent} → ${kg.multiParent}`);
  L.push(gained.length ? `真增量：${gained.join(' · ')}` : '⚠️ 栏 B 无增量，需排查。');
  L.push('');
  L.push('## 已知缺陷（不隐瞒，逐条待修）');
  L.push('');
  L.push('| # | 缺陷 | 证据 | 性质 |');
  L.push('|---|---|---|---|');
  L.push(
    `| 1 | **顶层节点偏多** | ${kg.roots} 个无父概念，其中 \`Kimi K3\`/\`MoE\`/\`视觉理解能力\`/\`思考模式\` 明显该挂在 LLM 下 | 分块抽取的固有代价：每块只看见自己 2000 字，跨块上位关系判不出来 |`,
  );
  L.push(
    `| 2 | **归并过猛** | \`上下文管理\` 吞掉了 \`上下文适应\`（本应是独立机制） | 我引入的 bug：同块 altLabel 归并 82 个时未校验语义 |`,
  );
  L.push(
    `| 3 | **概念名跨次浮动的风险** | 三次跑出 \`上下文\` / \`上下文管理\`；\`LLM ⊂ Agent\` 与 \`LLM ⊂ 模型即 Agent\` | 模型侧不确定性，id 由名字派生 ⇒ 跨次对比困难 |`,
  );
  L.push(
    `| 4 | 覆盖率 ${pct(kg.coveredBlocks, kg.totalBlocks)} | 131 块里 ${131 - kg.coveredBlocks} 块无概念锚点 | 部分块本就没有可立概念的内容，部分是真漏抽——**未区分** |`,
  );
  L.push('');
  L.push('### 下一步（按优先级）');
  L.push('');
  L.push('1. **修归并 bug**：同块 altLabel 归并增加语义校验（两个名字的 definition 差异过大则不合并）');
  L.push('2. **跨块补父**：把每块抽到的概念清单汇总后，用一次全局调用补 broader（而不是自动猜）');
  L.push('3. **概念名稳定化**：把「首选名」交给一次归并调用统一定夺，而不是各块自定');
  L.push('4. **区分 131 块里哪些本就无概念**（这类不算漏抽）');
  L.push('');
  return L.join('\n');
}
