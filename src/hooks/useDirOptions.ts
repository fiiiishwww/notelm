/**
 * src/hooks/useDirOptions.ts —— 目录下拉的选项（把整棵树摊平）。
 *
 * 上传、导入、另存为都要「选一个目录」，三处如果各写一份摊平逻辑，
 * 将来改规则（比如要不要排除某个内部目录）就得改三遍，而且很容易漏一处。
 *
 * ★ 两条规则 ★
 *   1. 根用**空串**表示，不是一个特殊标记——后端所有接口都把 '' 当根目录，
 *      前端跟着用空串就不用在提交前再做一次转换。
 *   2. 跳过 `.` 开头的目录。`.notebook` 是 sidecar / 回收站的存放处，
 *      让用户把文章导进去，目录树里会多出一个打不开的条目。
 */

import { useMemo } from 'react';
import { useApp } from '../state/store';
import type { TreeNode } from '../api';

export interface DirOption {
  rel: string;
  label: string;
}

export function useDirOptions(): DirOption[] {
  const { state } = useApp();

  return useMemo(() => {
    const out: DirOption[] = [{ rel: '', label: '笔记库根目录' }];
    const walk = (node: TreeNode, depth: number) => {
      for (const c of node.children ?? []) {
        if (c.type !== 'dir') continue;
        if (c.name.startsWith('.')) continue;
        out.push({ rel: c.relPath, label: `${'  '.repeat(depth)}${c.name}` });
        walk(c, depth + 1);
      }
    };
    if (state.tree) walk(state.tree, 0);
    return out;
  }, [state.tree]);
}
