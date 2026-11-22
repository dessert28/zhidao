/* ------------------------------------------------------------------
 * 协议正文页
 *
 * 从 agreementSource.getDocument() 取内容，与登录/注册勾选处共用同一数据源。
 * 当前是接口占位内容；接真实协议时只改数据源，本页不用动。
 * ------------------------------------------------------------------ */

import { Link, useParams } from 'react-router-dom';
import Logo from '../components/ui/Logo';
import { ChevronLeftIcon } from '../components/ui/icons';
import { useAgreementDocument } from '../hooks/useAgreements';
import type { AgreementId } from '../lib/auth/agreements';

function isAgreementId(value: string | undefined): value is AgreementId {
  return value === 'terms' || value === 'privacy';
}

export default function LegalPage() {
  const { type } = useParams();
  const valid = isAgreementId(type);
  // hook 不能条件调用；非法 id 时用 terms 占位，渲染时再走错误分支
  const { document, loading } = useAgreementDocument(valid ? type : 'terms');

  return (
    <div className="page-bg min-h-dvh">
      <div className="mx-auto w-full max-w-md px-5 py-8">
        <div className="mb-6 flex items-center gap-2">
          <Logo size={32} title="智诊通标识" />
          <span className="text-sm font-semibold tracking-wide text-gray-900">智诊通</span>
        </div>

        <article className="rounded-2xl border border-gray-100 bg-surface p-6 shadow-card">
          {!valid ? (
            <p className="text-sm text-gray-500">协议不存在。请从登录页重新进入。</p>
          ) : loading ? (
            <p className="text-sm text-gray-400">载入中…</p>
          ) : !document ? (
            <p className="text-sm text-gray-500">协议内容暂未开放，请稍后再试。</p>
          ) : (
            <>
              <h1 className="text-lg font-semibold text-gray-900">《{document.title}》</h1>
              <p className="mt-1 text-xs text-gray-400">更新日期：{document.updatedAt}</p>
              <div className="mt-6 space-y-5">
                {document.sections.map((section, i) => (
                  <section key={`${section.heading}-${i}`}>
                    <h2 className="text-sm font-semibold text-gray-800">{section.heading}</h2>
                    <p className="mt-1.5 text-sm leading-relaxed text-gray-600">{section.body}</p>
                  </section>
                ))}
              </div>
            </>
          )}
        </article>

        <Link
          to="/login"
          className="mt-6 inline-flex items-center gap-1 text-sm text-brand-700 hover:underline"
        >
          <ChevronLeftIcon size={16} /> 返回登录
        </Link>
      </div>
    </div>
  );
}
