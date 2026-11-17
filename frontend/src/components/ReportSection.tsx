/* ------------------------------------------------------------------
 * 检查报告区块 —— X 线 / CT / 彩超 / 心电图 / 内镜
 *
 * ============ 为什么单独一块 ============
 *
 * 化验单看的是「数值高不高」，影像和心电图看的是「结论要不要紧」。
 * 两类报告混在同一个时间轴里，患者会分不清该看什么。
 *
 * 这一块只放**结论型**报告（影像、心电、内镜），
 * 每条显示：类型标签 + 检查部位 + 结论原文 + 是否建议随访。
 *
 * ============ 一条边界 ============
 *
 * 「建议随访」只是**文本标记**：报告原文里写了「结节」「增厚」
 * 「建议复查」这类词。我们不解释它意味着什么 ——
 * 那是医生的工作。所以这里的措辞是「报告建议复查」，
 * 不是「你有问题」。
 * ------------------------------------------------------------------ */

import { useMemo } from 'react';
import { SectionTitle } from './ui/SectionTitle';
import type { MedicalRecord } from '../lib/api';
import { hospitalName } from '../lib/api';
import {
  KIND_META,
  isConclusionType,
  parseReport,
  type ParsedReport,
} from '../lib/health/reports';

interface Props {
  records: MedicalRecord[];
}

/** 一份报告 + 它来自哪次就诊 */
interface ReportRow {
  record: MedicalRecord;
  parsed: ParsedReport;
}

export function ReportSection({ records }: Props) {
  const rows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = [];
    for (const r of records) {
      const parsed = parseReport(r.ocrText ?? '', r.fileName);
      if (!isConclusionType(parsed.kind)) continue;
      // 既没结论也没所见，说明不是一份能读懂的报告，不占位置
      if (!parsed.conclusion && !parsed.findings) continue;
      out.push({ record: r, parsed });
    }
    // 按日期倒序
    return out.sort((a, b) => b.record.visitDate.localeCompare(a.record.visitDate));
  }, [records]);

  if (rows.length === 0) return null;

  const followUpCount = rows.filter((r) => r.parsed.needsFollowUp).length;

  return (
    <section>
      <SectionTitle>
        检查报告
        <span className="ml-2 text-xs font-normal text-gray-400">
          {rows.length} 份
          {followUpCount > 0 ? ` · ${followUpCount} 份建议复查` : ''}
        </span>
      </SectionTitle>

      <div className="space-y-2">
        {rows.map(({ record, parsed }) => (
          <ReportCard key={record.id} record={record} parsed={parsed} />
        ))}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-gray-400">
        以上内容照录报告原文，我们不做解读。「建议复查」表示报告里出现了检查医生
        建议随访的表述，具体怎么处理请遵医嘱。
      </p>
    </section>
  );
}

function ReportCard({ record, parsed }: { record: MedicalRecord; parsed: ParsedReport }) {
  const meta = KIND_META[parsed.kind];
  const flag = parsed.needsFollowUp;

  return (
    <div
      className={`rounded-xl border p-3 ${
        flag ? 'border-amber-300 bg-amber-50/50' : 'border-gray-200 bg-surface'
      }`}
    >
      {/* 头部：类型 + 部位 + 日期 */}
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="rounded bg-ink-strong px-1.5 py-0.5 text-3xs font-medium text-white">
          {meta.short}
        </span>
        <span className="text-sm font-medium text-gray-900">
          {/* 用 short（"超声"）而不是 label（"超声 / 彩超"），
              否则会拼成「颈动脉超声 / 彩超」这种读着别扭的名字 */}
          {parsed.bodyPart ? `${parsed.bodyPart}${meta.short}` : meta.label}
        </span>
        {flag ? (
          <span className="rounded bg-amber-600 px-1.5 py-0.5 text-3xs text-white">
            报告建议复查
          </span>
        ) : null}
        <span className="ml-auto text-xs tabular-nums text-gray-400">{record.visitDate}</span>
      </div>

      <div className="mt-0.5 text-xs text-gray-500">
        {hospitalName(record.hospitalCode)}
        {record.department ? ` · ${record.department}` : ''}
      </div>

      {/* 结论优先展示 —— 患者最想看的是这一句 */}
      {parsed.conclusion ? (
        <div className="mt-2 rounded-lg bg-surface/70 px-2.5 py-2">
          <div className="text-3xs text-gray-400">结论</div>
          <p className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-gray-800">
            {parsed.conclusion}
          </p>
        </div>
      ) : null}

      {/* 参数：心电图的客观数值 */}
      {parsed.params.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {parsed.params.map((p) => (
            <span key={p.name} className="text-xs text-gray-600">
              {p.name} <span className="font-medium tabular-nums text-gray-900">{p.value}</span>
            </span>
          ))}
        </div>
      ) : null}

      {/* 所见折叠：多数患者不需要读到这一层，但医生需要 */}
      {parsed.findings ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-2xs text-gray-400 hover:text-gray-600">
            查看检查所见
          </summary>
          <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-gray-600">
            {parsed.findings}
          </p>
        </details>
      ) : null}
    </div>
  );
}

