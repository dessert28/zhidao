/* ------------------------------------------------------------------
 * usePatientFacts —— 给对话链路提供 SessionFacts
 *
 * ============ 它解决什么问题 ============
 *
 * Reviewer 里的 `drugConflictCheck()` 与 `allergyCrosscheck()` 一直存在，
 * 但因为前端每轮只发 `{ text }`，`facts.currentMedications` 永远是空数组 ——
 * 这两个交叉检查形同虚设。README 承诺的「跨院用药冲突提示」因此
 * 在演示里根本看不到。
 *
 * 这个 hook 负责把「患者档案」转成「对话事实」，并在整个会话里复用。
 *
 * ============ 三个设计决定 ============
 *
 * 1. **只拉一次，缓存在模块级**。
 *    每轮对话都拉一次档案是浪费，而且后端慢的话会拖慢整个对话。
 *    档案在一次会话里基本不变。
 *
 * 2. **拿不到就是空数组，不阻塞对话**。
 *    后端没起时 facts 为空 —— 后果只是"少做两个交叉检查"，
 *    而不是"对话用不了"。这个取舍必须明确：AI 对话是主线。
 *
 * 3. **失败不重试**。会话期间后端恢复的概率低，
 *    重试只会在每轮对话前加一次超时等待。
 * ------------------------------------------------------------------ */

import { useEffect, useState } from 'react';
import { ensureLogin, getProfile, toSessionFacts, type PatientProfile, type BackendFailure } from '../lib/api';

export type SessionFactsLike = ReturnType<typeof toSessionFacts>;

const EMPTY_FACTS: SessionFactsLike = {
  allergies: [],
  chronicConditions: [],
  currentMedications: [],
  bookingState: null,
};

/** 模块级缓存：跨组件、跨渲染复用，一次会话只拉一次 */
let cache: SessionFactsLike | null = null;

export interface UsePatientFacts {
  facts: SessionFactsLike;
  profile: PatientProfile | null;
  /** 是否已经尝试过加载（用于区分"还没拉"与"拉到了空的"） */
  loaded: boolean;
  failure: BackendFailure | null;
}

export function usePatientFacts(): UsePatientFacts {
  const [facts, setFacts] = useState<SessionFactsLike>(cache ?? EMPTY_FACTS);
  const [profile, setProfile] = useState<PatientProfile | null>(null);
  const [loaded, setLoaded] = useState(Boolean(cache));
  const [failure, setFailure] = useState<BackendFailure | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const auth = await ensureLogin();
      if (cancelled) return;
      if (!auth.ok) {
        setFailure(auth.failure);
        setLoaded(true);
        return;
      }

      const r = await getProfile();
      if (cancelled) return;
      setLoaded(true);
      if (!r.ok) {
        setFailure(r.failure);
        return;
      }
      setProfile(r.data);
      setFacts(toSessionFacts(r.data));
      cache = toSessionFacts(r.data);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { facts, profile, loaded, failure };
}

/** 供测试或登出后重置 */
export function __resetPatientFactsCache(): void {
  cache = null;
}
