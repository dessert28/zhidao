/* ------------------------------------------------------------------
 * 出站文本测试 —— 钉住「预览算出来的，就是发出去的」这条
 *
 * 这个文件存在的理由是一类具体的 bug：
 *   预览按「规则 + 模型」合并计数，发送却只调 redact()（纯规则）。
 *   表现是预览写着"将遮蔽 2 处个人信息"，实际有 1 处原样发到了服务端。
 *   它不会让任何测试变红，也不会让界面看起来异常 —— 反而是界面
 *   一直在告诉用户"已经遮好了"。所以必须有一条断言盯着发送的字符串。
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { composeOutbound, prepareOutbound } from './outbound';
import { redact } from './redact';
import type { ModelEntityLike } from './merge';

const place = (text: string, start: number, end: number): ModelEntityLike => ({
  type: 'address',
  text,
  start,
  end,
});

describe('composeOutbound：模型命中必须真的进到出站文本里', () => {
  it('自由叙述里的地名被遮蔽（回归：之前只发规则结果）', () => {
    const raw = '我住梧桐里社区那边，最近头晕';
    const out = composeOutbound(raw, [], [place('梧桐里', 2, 5)]);

    expect(out.text).not.toContain('梧桐里');
    expect(out.text.startsWith('我住［住址已遮蔽］')).toBe(true);
    expect(out.modelUsed).toBe(true);
    expect(out.hits).toHaveLength(1);
  });

  it('模型标出的地名与规则命中互不干扰，其余文字一字不动', () => {
    const raw = '我住梧桐里社区那边，电话 13812345678';
    const rule = redact(raw);
    const out = composeOutbound(raw, rule.hits, [place('梧桐里', 2, 5)]);

    expect(out.text).toBe('我住［住址已遮蔽］社区那边，电话 138****5678');
  });
});

describe('composeOutbound：模型不可用时必须如实降级', () => {
  it('null 表示模型没参与，只做规则遮蔽并标记 modelUsed=false', () => {
    const raw = '我电话 13812345678';
    const rule = redact(raw);
    const out = composeOutbound(raw, rule.hits, null);

    expect(out.text).toContain('138****5678');
    expect(out.text).not.toContain('13812345678');
    expect(out.modelUsed).toBe(false);
    expect(out.hits).toHaveLength(rule.hits.length);
  });

  it('空数组（模型跑过但没命中）与 null（模型不可用）不能混为一谈', () => {
    const raw = '头晕三天了';
    const rule = redact(raw);

    const checked = composeOutbound(raw, rule.hits, []);
    const unavailable = composeOutbound(raw, rule.hits, null);

    // 文本一样（都没遮东西），但"检查过"这件事必须能被区分出来，
    // 否则界面会在模型没加载时告诉用户"未检测到个人信息"
    expect(checked.text).toBe(unavailable.text);
    expect(checked.modelUsed).toBe(true);
    expect(unavailable.modelUsed).toBe(false);
  });
});

describe('composeOutbound：文本与 hit 列表必须一致', () => {
  it('hits 升序，且能按顺序重组回出站文本', () => {
    const raw = '我住梧桐里社区那边 13812345678';
    const rule = redact(raw);
    const hit = place('梧桐里', raw.indexOf('梧桐里'), raw.indexOf('梧桐里') + 3);
    const out = composeOutbound(raw, rule.hits, [hit]);

    const starts = out.hits.map((h) => h.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));

    let cursor = 0;
    let rebuilt = '';
    for (const h of out.hits) {
      rebuilt += raw.slice(cursor, h.start) + h.placeholder;
      cursor = h.end;
    }
    rebuilt += raw.slice(cursor);
    expect(rebuilt).toBe(out.text);
  });

  it('规则与模型重叠时按规则结果走，不会重复遮蔽出两段占位符', () => {
    const raw = '住梧桐里社区，电话 13812345678';
    const rule = redact(raw);
    const s = raw.indexOf('梧桐里');
    const out = composeOutbound(raw, rule.hits, [place('梧桐里', s, s + 3)]);

    expect(out.text.match(/［住址已遮蔽］/g)).toHaveLength(1);
    expect(out.text).toContain('138****5678');
  });
});

describe('prepareOutbound：发送路径不触发模型下载', () => {
  it('模型未就绪时立即返回规则结果', async () => {
    const raw = '身份证 110101199003072316';
    const out = await prepareOutbound(raw);

    expect(out.modelUsed).toBe(false);
    expect(out.text).not.toContain('110101199003072316');
  });

  it('空文本不报错，也不凭空造遮蔽', async () => {
    const out = await prepareOutbound('   ');
    expect(out.text).toBe('   ');
    expect(out.hits).toHaveLength(0);
  });
});
