/**
 * server/services/approvals.ts —— 工具级审批的挂起注册表（2026-09-24）。
 *
 * ★ 它解决什么 ★
 *   在这之前，agent 想动库里的东西只有两条路：①feedback 审查管线（出计划文件 →
 *   她看 → 她在终端跑或说确认原话）②干脆没能力（她「指名要改某条」时 agent 只能
 *   说「规则上够不着」）。多鱼拍板：给小笔「指名就改」的能力，但**必须当场问她**，
 *   而且是弹确认框（主流做法），不是对话里用文字问她。
 *
 * ★ 它是什么 ★
 *   一个「挂起 → 等人点按钮 → 续跑」的机制。agent 的写工具调 createApproval()，
 *   拿到一个 promise 后 await；服务端把请求通过 NDJSON 流推给前端（内联确认卡），
 *   她点「批准/拒绝」→ POST /agent/approvals/:id → resolveApproval 解开 promise，
 *   agent 那边继续执行或放弃。
 *
 * ★ 为什么必须有超时 ★
 *   agent 会一直挂在这一步上等。她可能走开、合上电脑、或者页面早就关了。
 *   没有超时就是「静默悬挂」——她回来发现小笔卡死，还不如直接拒了。
 *   默认 5 分钟（NB_APPROVAL_TIMEOUT_MS 可配），超时按**拒绝**处理，
 *   且文案明确告诉她「没等到你，我没动」。
 *
 * ★ 内存表，不落盘 ★
 *   进程重启 → pending 全丢。这不是缺陷：重启时那条 NDJSON 流本身也断了，
 *   她在界面上看到的卡已经是死的——两者状态一致，不会出现「服务端还在等她、
 *   她那边卡早没了」的错位。真正落盘的只有**决议结果**（写进 feedback-actions.jsonl，
 *   由调用方负责）。
 */

export interface ApprovalAction {
  /** 机器可读的操作名，如 'item.remove'（落审计用） */
  op: string;
  /** 人话动词，如「移入回收站」 */
  opLabel: string;
  doc: string;
  /** 人话定位：「《chapter1》· 概念地图 · 第 3 条」——不能只给 ik，她看不懂 */
  where: string;
  /** 改前内容摘录（≤120 字） */
  before?: string;
  /** 改后内容摘录 */
  after?: string;
  /** 删除/覆盖类 —— 前端标红，她得多看一眼 */
  danger?: boolean;
}

export interface ApprovalRequest {
  id: string;
  /** 卡片标题，如「小笔想改 3 处」 */
  title: string;
  /** 依据说明（一般是她的原话） */
  note?: string;
  actions: ApprovalAction[];
  /** 整体危险级（任一 action danger 即为 true） */
  danger: boolean;
}

export interface ApprovalDecision {
  approved: boolean;
  /** '界面批准' / '界面拒绝' / '超时未响应' */
  by: string;
  at: string;
  timedOut?: boolean;
}

/**
 * 工具侧提交的请求内容（id 由 createApproval 生成，danger 可省=按 actions 推）。
 * ★ 工具只该看到这个类型，看不到 id——id 是传输层概念。
 */
export type ApprovalRequestDraft = Omit<ApprovalRequest, 'id' | 'danger'> & { danger?: boolean };

/** 默认等待上限：5 分钟。她中途走开也不会把 agent 挂死。 */
const DEFAULT_TIMEOUT_MS = 300_000;

function timeoutMsFromEnv(): number {
  const raw = Number(process.env.NB_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

interface Pending {
  req: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();
let seq = 0;

/** 待决议请求（前端刷新页面后可拉一次，恢复在路上的卡）。 */
export function listPendingApprovals(): ApprovalRequest[] {
  return [...pending.values()].map((p) => p.req);
}

export function pendingApprovalCount(): number {
  return pending.size;
}

/**
 * 注册一条审批请求并返回等待中的 promise。
 * 调用方（工具）应当把 req 通过 onApprovalRequest 通道发给前端，然后 await 这个 promise。
 */
export function createApproval(
  req: ApprovalRequestDraft,
  timeoutMs?: number,
): { id: string; request: ApprovalRequest; promise: Promise<ApprovalDecision> } {
  seq += 1;
  const id = `apr_${Date.now().toString(36)}_${seq}`;
  const full: ApprovalRequest = {
    ...req,
    id,
    danger: req.danger ?? req.actions.some((a) => a.danger === true),
  };
  let resolveFn!: (d: ApprovalDecision) => void;
  const promise = new Promise<ApprovalDecision>((res) => {
    resolveFn = res;
  });
  const limit = timeoutMs ?? timeoutMsFromEnv();
  const timer = setTimeout(() => {
    const cur = pending.get(id);
    if (!cur) return;
    pending.delete(id);
    cur.resolve({ approved: false, by: '超时未响应', at: new Date().toISOString(), timedOut: true });
  }, limit);
  // ★ 定时器故意不 unref ★（2026-09-24 探针实测踩到）
  //   unref 过的定时器不算活跃句柄：脚本里 await 这个 promise 时事件循环会直接
  //   结束——「等她点批准」变成「进程静默退出」。这个等待的语义就是**必须保活**：
  //   有未决议的审批 = 有活没干完，进程本来就不该走。
  pending.set(id, { req: full, resolve: resolveFn, timer });
  return { id, request: full, promise };
}

/**
 * 她点了按钮（或前端代她决议）。返回 false = 这条不存在或已决议过
 * （重复点击 / 旧页面残留 / 超时后才点，都走这里）。
 */
export function resolveApproval(id: string, approved: boolean): boolean {
  const cur = pending.get(id);
  if (!cur) return false;
  pending.delete(id);
  clearTimeout(cur.timer);
  cur.resolve({
    approved,
    by: approved ? '界面批准' : '界面拒绝',
    at: new Date().toISOString(),
  });
  return true;
}

/** 进程内主动清空（测试/关停用）。 */
export function clearApprovals(approved = false): void {
  for (const [id, cur] of pending) {
    clearTimeout(cur.timer);
    cur.resolve({ approved, by: '系统清空', at: new Date().toISOString() });
    pending.delete(id);
  }
}
