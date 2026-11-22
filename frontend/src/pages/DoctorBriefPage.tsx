/* ------------------------------------------------------------------
 * 预问诊摘要（契约状态页）
 *
 * ============ 为什么又是一张"承认不可用"的页面 ============
 *
 * 后端 DoctorBriefController 为这个接口写了很长的约束：token 一次性、
 * 短期有效、只读、只返回脱敏摘要、每次调阅留痕。当前实现恒定返回
 * 501（业务码 50101），因为令牌签发与授权是一整片新的安全面。
 *
 * 如果这里画一个输入框再塞几条假摘要，演示时就会让人以为"医生能
 * 读预问诊"已经做完 —— 而它保护的是真实健康数据。所以本页只做两件
 * 诚实的事：列出契约，以及真实请求一次把 501 原文显示出来。
 *
 * ============ 为什么不走 api.ts 的 request() ============
 *
 * 与 AdminKnowledgePage 同理：request() 把非 0 业务码压成 failure，
 * 我们需要的恰恰是 HTTP 状态码 + 原始 message。
 * ------------------------------------------------------------------ */

import { useState } from 'react';
import { DoctorShell } from '../components/doctor/DoctorShell';
import { Button } from '../components/ui/Button';
import { Callout } from '../components/ui/Callout';
import { Card } from '../components/ui/Card';
import { SectionTitle } from '../components/ui/SectionTitle';

const CONTRACT = [
  ['一次性', '首次成功读取即作废，链接被转发也不等于病历被转发'],
  ['短期有效', '与就诊时段绑定，过期即失效'],
  ['只读', '只能换摘要，不能改档案、下单或读原始病历附件'],
  ['脱敏', '不含姓名、手机号、身份证与病历原图'],
  ['可追溯', '每次调阅记录来源、时间与结果；重复消费是外泄信号'],
] as const;

type Probe =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'done'; status: number; message: string }
  | { phase: 'network-error'; message: string };

interface ErrorBody {
  code?: number;
  message?: string;
}

/** 从响应体里取 message；不是 JSON 就截一段，别把整页 HTML 打出来 */
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

export default function DoctorBriefPage() {
  const [token, setToken] = useState('');
  const [probe, setProbe] = useState<Probe>({ phase: 'idle' });

  async function check() {
    const value = token.trim();
    if (!value) return;
    setProbe({ phase: 'testing' });

    try {
      // token 拼在路径里，仅用于触发契约探测；后端当前不读取也不记录它。
      const res = await fetch(`/api/backend/api/doctor/brief/${encodeURIComponent(value)}`);
      const text = await res.text();
      setProbe({ phase: 'done', status: res.status, message: readMessage(text) });
    } catch {
      setProbe({
        phase: 'network-error',
        message: '请求没能发出，检查前端 dev server 与后端是否在运行。',
      });
    }
  }

  return (
    <DoctorShell title="预问诊摘要" subtitle="患者分享一次性链接 → 医生读取脱敏摘要 → 诊室里少问一遍">
      <Callout tone="neutral" dense title="当前状态：接口契约已定，功能待实现" className="mb-3">
        后端明确返回 HTTP 501（业务码 50101）。令牌签发、过期与重放检测尚未实现，
        这里不提供假摘要。
      </Callout>

      <Card className="mb-3">
        <SectionTitle>接口约束</SectionTitle>
        <ul className="space-y-1.5 text-xs leading-relaxed text-gray-600">
          {CONTRACT.map(([name, detail]) => (
            <li key={name}>
              <span className="font-medium text-gray-900">{name}</span> · {detail}
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <SectionTitle>检测接口状态</SectionTitle>
        <p className="text-xs leading-relaxed text-gray-500">
          填入任意字符串作为 token，真实请求一次
          <code className="mx-1 text-gray-700">GET /api/doctor/brief/&#123;token&#125;</code>
          ，把 HTTP 状态码和后端 message 原样显示。后端当前不读取 token 内容。
        </p>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="测试用 token（不会被记录）"
            aria-label="测试用 token"
            className="h-9 min-w-0 flex-1 rounded-lg border border-gray-200 bg-surface px-2.5 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
          />
          <Button onClick={() => void check()} disabled={!token.trim() || probe.phase === 'testing'}>
            {probe.phase === 'testing' ? '请求中…' : '检测接口状态'}
          </Button>
        </div>

        {probe.phase === 'done' ? (
          <div className="mt-2.5">
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600">
              <div className="text-2xs text-gray-400">HTTP 状态码</div>
              <div className="mt-0.5 tabular-nums">{probe.status}</div>
              <div className="mt-2 text-2xs text-gray-400">后端 message</div>
              <div className="mt-0.5 break-words">{probe.message}</div>
            </div>
            {probe.status === 501 ? (
              <Callout tone="alert" dense title="契约存在，功能未实现" className="mt-2">
                501 是刻意的诚实表达：路由在、能力不在。做成半成品比不做更危险。
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
    </DoctorShell>
  );
}
