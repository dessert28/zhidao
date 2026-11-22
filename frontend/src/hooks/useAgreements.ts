/* ------------------------------------------------------------------
 * 协议数据 hook
 *
 * 用 React Query 包一层数据源，好处有两个：
 * 1. 登录、注册、协议页共享同一份缓存，切换页面不会重复请求；
 * 2. initialData 让协议文字首帧就在，不会出现"先是空、过一下才冒出来"。
 * ------------------------------------------------------------------ */

import { useQuery } from '@tanstack/react-query';
import {
  agreementSource,
  FALLBACK_LINKS,
  type AgreementId,
} from '../lib/auth/agreements';

const STALE = 5 * 60_000;

/** 登录/注册勾选处的协议链接列表 */
export function useAgreementLinks() {
  const { data } = useQuery({
    queryKey: ['agreements', 'links'],
    queryFn: () => agreementSource.listLinks(),
    initialData: FALLBACK_LINKS,
    staleTime: STALE,
    retry: 1,
  });
  return data;
}

/** 协议页正文。id 非法时返回 null，由页面决定怎么提示。 */
export function useAgreementDocument(id: AgreementId) {
  const { data, isLoading } = useQuery({
    queryKey: ['agreements', 'document', id],
    queryFn: () => agreementSource.getDocument(id),
    staleTime: STALE,
    retry: 1,
  });
  return { document: data ?? null, loading: isLoading };
}
