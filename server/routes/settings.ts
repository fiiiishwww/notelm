/**
 * server/routes/settings.ts —— 笔记库位置与 AI 接口配置。
 *
 * 笔记库目录是本应用唯一会写到用户磁盘「任意位置」的地方，所以：
 *   - 设置时立刻做可写探测（assertWritableDir），不要等到用户编辑文章才报错；
 *   - 立刻建 .notebook 骨架，让用户看得见我们会在里面放什么。
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { Router } from 'express';
import { z } from 'zod';
import { ApiError, DEFAULT_VAULT, bad, readConfig, writeConfig, writeSecret } from '../core';
import { assertWritableDir } from '../security';
import { ensureNotebook } from '../services/sidecar';
import { getAiSettings, testConnection } from '../services/aiClient';
import { getEmbedSettings, testEmbedding } from '../services/embed';
import { clearTokenCache, getFeishuSettings, testFeishu } from '../services/feishu';
import { h, parse } from './http';
import { vaultInfo } from '../vault';

export const settingsRouter = Router();

/** 当前状态：笔记库 + AI 配置（**绝不返回 apiKey 明文**，只返回是否已设置）。 */
settingsRouter.get(
  '/settings/state',
  h(async (_req, res) => {
    const info = await vaultInfo();
    const cfg = await readConfig();
    const ai = await getAiSettings();
    const emb = await getEmbedSettings();
    const fs0 = await getFeishuSettings();
    res.json({
      vault: info,
      defaultVault: DEFAULT_VAULT,
      theme: cfg.theme,
      themeColor: cfg.themeColor,
      panelWidths: cfg.panelWidths,
      ai: {
        baseURL: ai.baseURL,
        model: ai.model,
        temperature: cfg.ai.temperature,
        hasApiKey: Boolean(ai.apiKey),
        /** 三项齐全才算配置完成，前端据此决定是否显示「AI 已就绪」 */
        configured: ai.configured,
      },
      embedding: {
        baseURL: emb.baseURL,
        model: emb.model,
        dimensions: cfg.embedding.dimensions,
        hasApiKey: Boolean(emb.apiKey),
        configured: emb.configured,
      },
      // appSecret 绝不回传前端，只说「有没有」
      feishu: {
        appId: fs0.appId,
        hasAppSecret: Boolean(fs0.appSecret),
        configured: fs0.configured,
      },
    });
  }),
);

const setVaultSchema = z.object({
  /** 绝对路径；留空表示清除配置 */
  root: z.string().max(4096).optional(),
  /** 使用内置默认目录（项目下的 notes/） */
  useDefault: z.boolean().optional(),
});

settingsRouter.post(
  '/settings/vault',
  h(async (req, res) => {
    const body = parse(setVaultSchema, req.body, '笔记库设置');
    let target: string | null;
    if (body.useDefault) {
      target = DEFAULT_VAULT;
    } else {
      target = (body.root ?? '').trim() || null;
    }

    if (target) {
      // Windows 上用户可能粘进来带引号的路径，先剥掉
      target = target.replace(/^"(.*)"$/, '$1').trim();
      if (!path.isAbsolute(target)) throw bad('笔记库路径需要是绝对路径，例如 D:\\notes');
      await fsp.mkdir(target, { recursive: true }).catch((e: NodeJS.ErrnoException) => {
        throw new ApiError(400, `无法创建笔记库目录：${e.message}`, 'bad_vault_path');
      });
      await assertWritableDir(target);
      await ensureNotebook(target);
    }

    await writeConfig({ vaultRoot: target });
    const info = await vaultInfo();
    res.json({ vault: info });
  }),
);

const aiSchema = z.object({
  baseURL: z.string().max(2048).optional(),
  model: z.string().max(256).optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** 传空字符串表示「不要改动已保存的 key」；传具体值则覆盖 */
  apiKey: z.string().max(4096).optional(),
});

settingsRouter.post(
  '/settings/ai',
  h(async (req, res) => {
    const body = parse(aiSchema, req.body, 'AI 设置');
    const cfg = await readConfig();
    // 只覆盖前端明确传上来的字段，没传的保持原值（前端可以只改模型名而不动地址）
    const nextAi = {
      baseURL: body.baseURL !== undefined ? body.baseURL.trim() : cfg.ai.baseURL,
      model: body.model !== undefined ? body.model.trim() : cfg.ai.model,
      temperature: body.temperature !== undefined ? body.temperature : cfg.ai.temperature,
    };
    await writeConfig({ ai: nextAi });

    // apiKey 为空串时视为「不改」，这样前端可以只改 model 而不必重新粘贴 key
    if (body.apiKey !== undefined && body.apiKey !== '') {
      await writeSecret({ apiKey: body.apiKey.trim() });
    }
    const ai = await getAiSettings();
    res.json({
      ai: {
        baseURL: ai.baseURL,
        model: ai.model,
        temperature: nextAi.temperature,
        hasApiKey: Boolean(ai.apiKey),
        configured: ai.configured,
      },
    });
  }),
);

/** 清空 API Key。 */
settingsRouter.delete(
  '/settings/ai/key',
  h(async (_req, res) => {
    await writeSecret({ apiKey: '' });
    res.json({ ok: true });
  }),
);

settingsRouter.post(
  '/settings/ai/test',
  h(async (_req, res) => {
    const r = await testConnection();
    res.json(r);
  }),
);

// ─────────────────────── 向量接口（检索用，与对话接口完全独立） ───────────────────────

const embeddingSchema = z.object({
  baseURL: z.string().max(2048).optional(),
  model: z.string().max(256).optional(),
  /** 0 或省略 = 不指定，用接口返回的原生维度 */
  dimensions: z.number().int().min(0).max(8192).optional(),
  /** 传空字符串表示「不要改动已保存的 key」；传具体值则覆盖 */
  apiKey: z.string().max(4096).optional(),
});

settingsRouter.post(
  '/settings/embedding',
  h(async (req, res) => {
    const body = parse(embeddingSchema, req.body, '向量接口设置');
    const cfg = await readConfig();
    const next = {
      baseURL: body.baseURL !== undefined ? body.baseURL.trim() : cfg.embedding.baseURL,
      model: body.model !== undefined ? body.model.trim() : cfg.embedding.model,
      dimensions: body.dimensions !== undefined ? body.dimensions : cfg.embedding.dimensions,
    };
    await writeConfig({ embedding: next });

    if (body.apiKey !== undefined && body.apiKey !== '') {
      await writeSecret({ embedApiKey: body.apiKey.trim() });
    }

    const emb = await getEmbedSettings();
    res.json({
      embedding: {
        baseURL: emb.baseURL,
        model: emb.model,
        dimensions: emb.dimensions,
        hasApiKey: Boolean(emb.apiKey),
        configured: emb.configured,
      },
    });
  }),
);

settingsRouter.delete(
  '/settings/embedding/key',
  h(async (_req, res) => {
    await writeSecret({ embedApiKey: '' });
    res.json({ ok: true });
  }),
);

settingsRouter.post(
  '/settings/embedding/test',
  h(async (_req, res) => {
    const r = await testEmbedding();
    res.json(r);
  }),
);

// ─────────────────────── 飞书导入（第三条凭据，和对话 / 向量完全独立） ───────────────────────

const feishuSchema = z.object({
  appId: z.string().max(256).optional(),
  /** 传空串表示「不改」，这样用户可以只改 app_id 而不必重新粘贴密钥 */
  appSecret: z.string().max(1024).optional(),
});

settingsRouter.post(
  '/settings/feishu',
  h(async (req, res) => {
    const body = parse(feishuSchema, req.body, '飞书设置');
    const cfg = await readConfig();
    const appId = body.appId !== undefined ? body.appId.trim() : cfg.feishu.appId;
    await writeConfig({ feishu: { appId } });
    if (body.appSecret !== undefined && body.appSecret !== '') {
      await writeSecret({ feishuAppSecret: body.appSecret.trim() });
    }
    // ★ 凭据变了必须让 token 缓存立刻失效 ★
    // 否则会拿着旧 token 去请求，报出来的错会让人以为是文档没授权，越查越偏。
    clearTokenCache();

    const s = await getFeishuSettings();
    res.json({
      feishu: { appId: s.appId, hasAppSecret: Boolean(s.appSecret), configured: s.configured },
    });
  }),
);

settingsRouter.delete(
  '/settings/feishu/secret',
  h(async (_req, res) => {
    await writeSecret({ feishuAppSecret: '' });
    clearTokenCache();
    res.json({ ok: true });
  }),
);

/** 只验证凭据对不对（换一次 tenant_access_token），不碰任何文档。 */
settingsRouter.post(
  '/settings/feishu/test',
  h(async (_req, res) => {
    res.json(await testFeishu());
  }),
);

const prefsSchema = z.object({
  theme: z.enum(['light', 'dark']).optional(),
  /** #RRGGBB；hover/soft/border/夜色版由前端派生，服务端只存这一个值 */
  themeColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, '主题颜色需为 #RRGGBB 格式')
    .optional(),
  panelWidths: z.object({ left: z.number().min(120).max(1200), right: z.number().min(120).max(1200) }).optional(),
});

/** 界面偏好（主题、面板宽度）单独一个接口，避免和 AI 配置互相干扰。 */
settingsRouter.post(
  '/settings/prefs',
  h(async (req, res) => {
    const body = parse(prefsSchema, req.body, '界面偏好');
    const cfg = await writeConfig(body);
    res.json({ theme: cfg.theme, themeColor: cfg.themeColor, panelWidths: cfg.panelWidths });
  }),
);
