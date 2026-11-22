/* ------------------------------------------------------------------
 * 用户协议 / 隐私政策 —— 数据源适配层
 *
 * ============ 为什么要单独一层 ============
 * 登录、注册、协议页三处都要用到协议名和链接。把它们写死在组件里，
 * 接真实后端时就得翻遍三个文件改字符串，漏一处就出现"登录页能点开、
 * 注册页点了 404"。
 *
 * 这一层只定义"协议数据从哪来"，不关心页面长什么样：
 *   · 登录/注册要的是链接列表 —— listLinks()
 *   · 协议页要的是正文 —— getDocument()
 *
 * 数据来自后端 GET /api/agreements（见 AgreementController），
 * 改协议文本只需动后端，前端不发版。
 * ------------------------------------------------------------------ */

import { getAgreementDocument, getAgreementLinks, type AgreementLinkData } from '../api';

export type AgreementId = 'terms' | 'privacy';

/** 登录/注册页协议勾选处展示的一条链接 */
export interface AgreementLink {
  id: AgreementId;
  /** 展示文案，如「用户协议」（书名号由展示层加，避免数据里带标点） */
  label: string;
  /** 站内跳转路径 */
  href: string;
}

/** 协议正文。真实接口接入后，sections 可直接映射后端返回的条款数组。 */
export interface AgreementDocument {
  id: AgreementId;
  title: string;
  /** 最后更新日期，ISO 日期字符串 */
  updatedAt: string;
  sections: Array<{ heading: string; body: string }>;
}

/**
 * 协议数据源接口。
 *
 * 用 Promise 而不是同步返回值：真实接口一定是异步的，
 * 现在就按异步签名写，接后端时不用改调用方的类型。
 */
export interface AgreementSource {
  listLinks(): Promise<AgreementLink[]>;
  getDocument(id: AgreementId): Promise<AgreementDocument | null>;
}

/** 链接兜底值：接口失败时协议入口也不能整块消失 */
export const FALLBACK_LINKS: AgreementLink[] = [
  { id: 'terms', label: '用户协议', href: '/legal/terms' },
  { id: 'privacy', label: '隐私政策', href: '/legal/privacy' },
];

/**
 * 真实数据源：调后端 /api/agreements。
 *
 * 失败时降级到内置兜底：协议入口不能因为后端没起就整块消失 ——
 * 注册页必须能展示我已阅读并同意，否则用户无法完成注册。
 */
export const agreementSource: AgreementSource = {
  async listLinks() {
    const r = await getAgreementLinks();
    if (!r.ok) return FALLBACK_LINKS;
    return r.data
      .filter((x): x is AgreementLinkData & { id: AgreementId } =>
        x.id === 'terms' || x.id === 'privacy')
      .map((x) => ({ id: x.id, label: x.label, href: x.href }));
  },
  async getDocument(id) {
    const r = await getAgreementDocument(id);
    if (!r.ok) return FALLBACK_DOCUMENTS[id] ?? null;
    return {
      id: r.data.id,
      title: r.data.title,
      updatedAt: r.data.updatedAt,
      sections: r.data.sections,
    };
  },
};

/** 正文兜底：后端不可达时仍能看到占位说明，而不是空白页 */
const FALLBACK_DOCUMENTS: Record<AgreementId, AgreementDocument> = {
  terms: {
    id: 'terms',
    title: '用户协议',
    updatedAt: '2026-11-19',
    sections: [
      {
        heading: '暂未连接',
        body: '协议服务暂不可用，请稍后重试。系统只做信息整理、风险提示与就诊准备，不提供诊断、用药或停药建议。',
      },
    ],
  },
  privacy: {
    id: 'privacy',
    title: '隐私政策',
    updatedAt: '2026-11-19',
    sections: [
      {
        heading: '暂未连接',
        body: '协议服务暂不可用，请稍后重试。演示环境不会收集或存储真实个人信息。',
      },
    ],
  },
};
