/* ------------------------------------------------------------------
 * 导诊知识库（占位）
 *
 * ============ 为什么这页要"承认不能用" ============
 *
 * `/api/admin/knowledge/**` 的三个端点在文档里已经定了契约，但后端当前
 * 恒定返回 501 + 50102。这一页如果画一个上传框、再给一条假的文档列表，
 * 演示时按下去就会当场穿帮；更糟的是有人会以为"上传成功"了。
 *
 * 所以这里做的是**状态展示页**：列出契约、提供一次真实的探测、
 * 把 501 的原文吐出来。答辩时这一页的说服力恰恰来自"我们宁可不做，
 * 也不返回空列表假装有数据"——知识库的切分与问答对生成一旦编造，
 * 患者会拿它当就诊依据，这个风险远大于"功能未完成"。
 *
 * ============ 为什么不走 api.ts 的 request() ============
 *
 * request() 把非 0 的业务码统一压成 failure，我们需要的恰恰是
 * **HTTP 状态码 + 原始 message**。这三个端点本来就只用来展示状态，
 * 单开一次 fetch 比在通用客户端上加一个"别压错误"的开关更干净。
 * ------------------------------------------------------------------ */

import { useState } from 'react';
import { AdminShell } from '../../components/admin/AdminShell';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { Card } from '../../components/ui/Card';
import { SectionTitle } from '../../components/ui/SectionTitle';
import { currentToken } from '../../lib/api';

const ENDPOINTS = [
  {
    method: 'GET',
    path: '/api/admin/knowledge/documents',
    purpose: '列出已上传的就诊须知文档及其切分状态',
  },
  {
    method: 'POST',
    path: '/api/admin/knowledge/documents',
    purpose: '上传一份就诊须知（PDF/文本），落库后等待切分',
  },
  {
    method: 'POST',
    path: '/api/admin/knowledge/reindex',
    purpose: '为指定文档重建检索索引（切块 → 生成问答对）',
  },
];

type Probe =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'done'; status: number; message: string }
  | { phase: 'network-error'; message: string };

interface ErrorBody {
  code?: number;
  message?: string;
}

/** 从响应体里取 message；不是 JSON 就把原文截一段，别把整页 HTML 打出来 */
function readMessage(text: string): string {
  if (!text) return '（响应体为空）';
  try {
    const body = JSON.parse(text) as ErrorBody;
    if (typeof body.message === 'string' && body.message) return body.message;
  } catch {
    /* 不是 JSON，走下面的截断 */
  }
  return text.slice(0, 200);
}

export default function AdminKnowledgePage() {
  const [probe, setProbe] = useState<Probe>({ phase: 'idle' });

  async function check() {
    setProbe({ phase: 'testing' });

    const token = currentToken();
    try {
      const res = await fetch('/api/backend/api/admin/knowledge/documents', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const text = await res.text();
      setProbe({ phase: 'done', status: res.status, message: readMessage(text) });
    } catch {
      // fetch 本身失败 = 前端 dev server 或代理没起来，与后端 501 是两件事
      setProbe({ phase: 'network-error', message: '请求没能发出，检查前端 dev server 是否在运行。' });
    }
  }

  return (
    <AdminShell title="导诊知识库" subtitle="院方上传就诊须知 → 切块 → 生成问答对 → 进检索索引">
      <Callout tone="neutral" dense title="当前状态：接口契约已定，功能待实现" className="mb-3">
        三个端点目前恒定返回 HTTP 501（业务码 50102）。这块先留位置，不在界面上假装可用。
      </Callout>

      <SectionTitle count={`${ENDPOINTS.length} 个端点`}>接口契约</SectionTitle>
      <ul className="space-y-2">
        {ENDPOINTS.map((e) => (
          <li key={`${e.method} ${e.path}`}>
            <Card pad="sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className={
                    'rounded px-1.5 py-0.5 text-2xs font-medium ' +
                    (e.method === 'GET' ? 'bg-brand-50 text-brand-700' : 'bg-gray-100 text-gray-600')
                  }
                >
                  {e.method}
                </span>
                <code className="min-w-0 break-all text-xs text-gray-900">{e.path}</code>
              </div>
              <div className="mt-1 text-xs leading-relaxed text-gray-500">{e.purpose}</div>
            </Card>
          </li>
        ))}
      </ul>

      <Card className="mt-3">
        <SectionTitle>检测接口状态</SectionTitle>
        <p className="text-xs leading-relaxed text-gray-500">
          真实请求一次 <code className="text-gray-700">GET /documents</code>，把 HTTP 状态码和后端返回的
          message 原样显示。这一条是给答辩现场用的：不靠截图，直接看。
        </p>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button onClick={() => void check()} disabled={probe.phase === 'testing'}>
            {probe.phase === 'testing' ? '请求中…' : '检测接口状态'}
          </Button>
          {probe.phase === 'done' ? (
            <span className="text-xs tabular-nums text-gray-600">HTTP {probe.status}</span>
          ) : null}
        </div>

        {probe.phase === 'done' ? (
          <div className="mt-2.5">
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600">
              <div className="text-2xs text-gray-400">后端 message</div>
              <div className="mt-0.5 break-words">{probe.message}</div>
            </div>

            {probe.status === 501 ? (
              <Callout
                tone="alert"
                dense
                title="接口契约已定，功能待实现"
                className="mt-2"
              >
                切分与问答对生成会引入编造风险，宁可返回 501 也不返回空列表。
              </Callout>
            ) : (
              <Callout tone="neutral" dense className="mt-2">
                状态码不是预期的 501 —— 后端可能刚上线了这部分，请重新核对契约文档。
              </Callout>
            )}
          </div>
        ) : null}

        {probe.phase === 'network-error' ? (
          <Callout tone="critical" dense className="mt-2.5">
            {probe.message}
          </Callout>
        ) : null}
      </Card>

      <Card className="mt-3">
        <SectionTitle>这块将来做什么</SectionTitle>
        <ul className="space-y-1.5 text-xs leading-relaxed text-gray-600">
          <li>1. 院方在后台上传「就诊须知 / 楼层指引 / 检查注意事项」等文档。</li>
          <li>2. 按标题与段落切块，每块保留出处，便于回答时引用原文。</li>
          <li>3. 由大模型生成问答对，但每一条都要人工过一遍才进索引 ——
            这是"编造风险"的具体落点。</li>
          <li>4. 患者问「抽血前要空腹吗」时先查索引，查不到就直接说不知道，
            而不是让模型自由发挥。</li>
        </ul>
      </Card>
    </AdminShell>
  );
}
