/* ------------------------------------------------------------------
 * 就诊摘要的纯文本生成
 *
 * ============ 为什么单独抽出来 ============
 *
 * 「复制文字」的输出是患者直接粘给医生的内容。它错了，医生看到的就是
 * 错的病史 —— 比页面上显示错更严重，因为没人会去核对一段粘贴的文字。
 *
 * 抽成纯函数之后可以完整单测，不必启动浏览器。
 * ------------------------------------------------------------------ */

import type { PatientProfile } from '../api';
import { hospitalName } from '../api';
import type { MarkerTrend } from './markers';

export interface SummaryInput {
  profile: PatientProfile | null;
  trends: MarkerTrend[];
  records: Array<{
    visitDate: string;
    hospitalCode: string;
    department?: string | null;
    diagnosisBrief?: string | null;
  }>;
  medications: Array<{ name: string; dose: string | null; frequency: string | null; timing: string | null }>;
}

/** 性别枚举 → 中文。给中国医生看的纸面上不该出现 MALE。 */
export function genderLabel(g: string | null | undefined): string | null {
  if (!g) return null;
  const map: Record<string, string> = {
    MALE: '男',
    FEMALE: '女',
    OTHER: '其他',
    男: '男',
    女: '女',
  };
  return map[g.toUpperCase()] ?? g;
}

/**
 * 生成可直接粘贴给医生的纯文本摘要。
 *
 * <p>排版只为「手机上读得下去」：用空行分段，不给每行编号，
 * 因为医生会把这段贴在病历里，编号反而是噪音。
 */
export function buildSummaryText(input: SummaryInput, today = new Date().toLocaleDateString('sv-SE')): string {
  const { profile: p, trends, records, medications } = input;
  const lines: string[] = [];

  lines.push('【就诊摘要】');
  lines.push(`整理日期 ${today}`);

  const basics: string[] = [];
  if (p?.age) basics.push(`${p.age} 岁`);
  const g = genderLabel(p?.gender);
  if (g) basics.push(g);
  if (basics.length) lines.push(basics.join(' · '));

  if (p?.allergies?.length) lines.push(`过敏：${p.allergies.join('、')}`);
  if (p?.chronics?.length) lines.push(`慢病：${p.chronics.join('、')}`);

  if (medications.length) {
    lines.push('');
    lines.push('【在用药】');
    for (const m of medications) {
      const parts = [m.dose, m.frequency, m.timing].filter(Boolean);
      lines.push(`  ${m.name}${parts.length ? ' ' + parts.join(' ') : '（用法未记录）'}`);
    }
  } else if (p?.medications?.length) {
    // 档案里有药名但病历里没有用法 —— 仍要告诉医生患者在吃这些
    lines.push('');
    lines.push('【在用药】');
    for (const n of p.medications) lines.push(`  ${n}（用法未记录）`);
  }

  if (trends.length) {
    lines.push('');
    lines.push('【近期指标】');
    for (const t of trends) {
      const last = t.points[t.points.length - 1]!;
      const flag = last.level === 'normal' ? '' : last.level === 'high' ? ' 偏高' : ' 偏低';
      lines.push(`  ${t.name} ${t.latest} ${t.unit}${flag}（${last.date}）`);
    }
  }

  if (records.length) {
    lines.push('');
    lines.push('【就诊记录】');
    const sorted = [...records].sort((a, b) => b.visitDate.localeCompare(a.visitDate));
    for (const r of sorted) {
      const seg = [r.visitDate, hospitalName(r.hospitalCode), r.department ?? '', r.diagnosisBrief ?? '']
        .filter((x) => x && String(x).trim())
        .join(' ');
      lines.push(`  ${seg}`);
    }
  }

  const hospitalCount = new Set(records.map((r) => r.hospitalCode)).size;
  lines.push('');
  lines.push(
    `以上由本人用「智诊通」整理，数据来自本人上传的 ${records.length} 份病历` +
      (hospitalCount ? `（覆盖 ${hospitalCount} 家医院）` : '') +
      '，未经医院核对，仅供医生参考。',
  );

  return lines.join('\n');
}
