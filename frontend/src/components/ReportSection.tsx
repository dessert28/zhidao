/* ------------------------------------------------------------------
 * 报告解读区块 —— 所有上传的报告（化验 / 影像 / 心电 / 内镜 / 病理）
 *
 * ============ 它做的是「读懂原文」，不是「给出结论」 ============
 *
 * 一份报告里有两层信息：
 *   第一层是结论本身（「双肺纹理清晰」「窦性心律」）—— 照录原文
 *   第二层是那些患者不认识的词 —— 这一块给白话注解
 *
 * 所以界面结构是固定的：**原文在上，注解在下，顺序不能反**。
 * 反过来会出现「先看我们的解释，再看医生说的一句话」，
 * 患者的注意力会落在解释上，而不是报告本身。
 *
 * ============ 一条不越的线 ============
 *
 * 注解只解释「这个词描述的是什么现象」，永远不出现
 * 「要不要紧 / 严不严重 / 该不该治」。判断留给写报告的医生。
 * 脚注必须一直显示，不能折起来 —— 它是这块内容的性质说明。
 * ------------------------------------------------------------------ */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { SectionTitle } from './ui/SectionTitle';
import { Clamp, Fold } from './ui/Fold';
import type { MedicalRecord } from '../lib/api';
import { hospitalName } from '../lib/api';
import {
  KIND_META,
  parseReport,
  type ParsedReport,
} from '../lib/health/reports';
import { interpretReport, hasInterpretation, type ReportInterpretation } from '../lib/health/interpret';
import type { TermHit } from '../lib/health/glossary';
import { fetchAiTerms } from '../lib/health/interpret-ai';
import {
  parseLabValues,
  summarizeLabValues,
  type LabFlag,
  type LabValue,
  type LabValueSummary,
} from '../lib/health/lab-values';

interface Props {
  records: MedicalRecord[];
}

/** 一份报告 + 它的结构与解读 */
interface ReportRow {
  record: MedicalRecord;
  parsed: ParsedReport;
  interp: ReportInterpretation;
  /** 化验单才有：报告里的原始数值条目 */
  lab: LabValueSummary | null;
}

export function ReportSection({ records }: Props) {
  const rows = useMemo<ReportRow[]>(() => {
    const out: ReportRow[] = [];
    for (const r of records) {
      const text = r.ocrText ?? '';
      const parsed = parseReport(text, r.fileName);
      const interp = interpretReport(text, r.fileName, parsed);
      /*
       * 化验单的数值单独读一遍。
       *
       * 这一步不能省：一张血常规 20 项，词库里未必覆盖到、也没有
       * 「所见/结论」段落，只靠术语命中它会整块消失 —— 而患者最想看的
       * 恰恰是那些数字。所以「读出了数值」本身也算这份材料值得展示。
       */
      const lab = parsed.kind === 'LAB' ? summarizeLabValues(parseLabValues(text)) : null;
      /*
       * 什么算「一份报告」：
       *   · 有结论或所见的（影像、心电、内镜）
       *   · 或者读出了化验数值
       *   · 或者虽然没段落，但正文里出现了能注解的术语（扫描件化验单）
       *
       * 门诊病历既没有报告段落、也没有数值、也没有专业术语，不该占这里的位置。
       */
      if (!hasInterpretation(interp, Boolean(text.trim()))) continue;
      if (interp.lines.length === 0 && interp.terms.length === 0 && (lab?.rows.length ?? 0) === 0) {
        continue;
      }
      /*
       * 认不出类型的材料再收一道口子：没有「所见/结论」、也没读出数值的，
       * 只剩几个能注解的词（门诊记录里的「复查」「血糖」），
       * 不该占「报告解读」的位置。
       */
      if (parsed.kind === 'OTHER' && interp.lines.length === 0 && (lab?.rows.length ?? 0) === 0) {
        continue;
      }
      out.push({ record: r, parsed, interp, lab });
    }
    return out.sort((a, b) => b.record.visitDate.localeCompare(a.record.visitDate));
  }, [records]);

  if (rows.length === 0) return null;

  const followUpCount = rows.filter((r) => r.parsed.needsFollowUp).length;
  const termCount = rows.reduce((n, r) => n + r.interp.terms.length, 0);

  return (
    <section>
      <SectionTitle>
        报告解读
        <span className="ml-2 text-xs font-normal text-gray-400">
          {rows.length} 份
          {termCount > 0 ? ` · ${termCount} 个术语` : ''}
          {followUpCount > 0 ? ` · ${followUpCount} 份建议复查` : ''}
        </span>
      </SectionTitle>

      <div className="space-y-2">
        {rows.map(({ record, parsed, interp, lab }) => (
          <ReportCard key={record.id} record={record} parsed={parsed} interp={interp} lab={lab} />
        ))}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-gray-400">
        结论与所见照录报告原文，一字未改。下面的术语注解只解释这个词在医学上指什么，
        不判断结果轻重。「建议复查」表示报告里出现了检查医生建议随访的表述，
        具体怎么处理请遵医嘱。
      </p>
    </section>
  );
}

function ReportCard({
  record,
  parsed,
  interp,
  lab,
}: {
  record: MedicalRecord;
  parsed: ParsedReport;
  interp: ReportInterpretation;
  lab: LabValueSummary | null;
}) {
  const meta = KIND_META[parsed.kind];
  const flag = parsed.needsFollowUp;
  const isLab = parsed.kind === 'LAB';

  return (
    <div
      className={`rounded-xl border p-3 ${
        flag ? 'border-amber-300 bg-amber-50/50' : 'border-gray-200 bg-surface'
      }`}
    >
      {/* 头部：类型 + 部位 + 日期 */}
      <div className="flex flex-wrap items-baseline gap-2">
        {/*
          只有「部位 + 类型」的标题才配一个类型标签（胸部 CT / 颈动脉超声）。
          没有部位的（化验单、内镜、其他）标题本身就是类型，
          再挂一个同样的标签会读成「内镜 内镜」「化验 化验单」。
        */}
        {parsed.bodyPart ? (
          <span className="rounded bg-ink-strong px-1.5 py-0.5 text-3xs font-medium text-white">
            {meta.short}
          </span>
        ) : null}
        <span className="text-sm font-medium text-gray-900">
          {/*
            标题用解读模块算好的名字（「胸部CT」「化验单」「病理」），
            而不是自己拼 bodyPart + short —— 化验单没有部位，
            拼出来会和左边的类型标签重复成「化验 化验」。
          */}
          {interp.title}
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

      {/* 化验单：把报告里的原始数值一列一列摆出来 */}
      {isLab ? <LabValues summary={lab} record={record} /> : null}

      <TermNotes interp={interp} record={record} />
    </div>
  );
}

/* ------------------------------------------------------------------
 * 化验数值表
 *
 * ============ 为什么必须把数字摆出来 ============
 *
 * 原来的做法是「数值去健康管家看」。但那页只跟踪血糖、血脂、血压等
 * 十来个常见指标，一张血常规 20 项里它只认得一两条 ——
 * 于是患者看到的是「数值请看别处」，点过去又没有，等于什么都没给。
 *
 * 这里直接读报告原文，**报告印了几项就列几项**，
 * 判断高低用的是这张报告自己印的参考范围。
 *
 * ============ 一条线 ============
 *
 * 「高于 / 低于参考范围」是区间比较，不是判断。所以：
 *   · 措辞只有「高于参考范围 / 低于参考范围」，没有「偏高 / 异常」
 *   · 不解释原因、不给建议，一句「怎么理解请交给开单医生」
 * ------------------------------------------------------------------ */

function LabValues({ summary, record }: { summary: LabValueSummary | null; record: MedicalRecord }) {
  const raw = (record.ocrText ?? '').trim();
  const rows = summary?.rows ?? [];
  const high = summary?.high ?? 0;
  const low = summary?.low ?? 0;
  const outside = high + low;
  const comparable = rows.filter((r) => r.flag !== 'unknown').length;

  const countText =
    rows.length === 0
      ? ''
      : outside > 0
        ? `共 ${rows.length} 项 · ${outside} 项超出参考范围`
        : comparable === rows.length
          ? `共 ${rows.length} 项 · 都落在参考范围内`
          : `共 ${rows.length} 项`;

  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-surface/60 px-2.5 py-2">
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xs font-medium text-gray-600">数值</span>
        {countText ? <span className="text-3xs text-gray-400">{countText}</span> : null}
      </div>

      {rows.length > 0 ? (
        <>
          <div className="mt-1.5">
            <Clamp
              items={rows}
              initial={6}
              unit="项"
              itemKey={(v) => v.name}
              gap="space-y-1"
              render={(v) => <LabRow value={v} />}
            />
          </div>
          <p className="mt-1.5 text-2xs leading-relaxed text-gray-400">
            对照的是这张报告上印的参考范围，不同医院、不同仪器的范围可能不一样。
            数字在区间之外只说明它不在这个区间里，是什么原因、要不要处理，请交给开单医生。
          </p>
        </>
      ) : (
        <p className="mt-1 text-xs leading-relaxed text-gray-500">
          没能从这份报告里自动读出数值条目（扫描件排版不规整时会这样）。
          下面的原文里有完整数值，可以直接看，也可以给医生看。
        </p>
      )}

      {raw ? (
        <Fold label="查看报告原文" hint={`${raw.length} 字`} className="mt-1.5">
          <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-surface/70 px-2 py-1.5 text-xs leading-relaxed text-gray-600">
            {raw}
          </p>
        </Fold>
      ) : null}

      <p className="mt-1 text-2xs leading-relaxed text-gray-400">
        想按时间看同一项的变化，去
        <Link to="/health" className="mx-0.5 text-brand-700 underline underline-offset-2">
          健康管家
        </Link>
        （目前跟踪血糖、血脂、血压等常见指标）。
      </p>
    </div>
  );
}

function LabRow({ value }: { value: LabValue }) {
  const out = value.flag === 'high' || value.flag === 'low';
  return (
    <div className="flex items-baseline gap-1.5 text-xs">
      <span className="min-w-0 flex-1 truncate text-gray-700" title={value.name}>
        {value.name}
      </span>
      <span
        className={`shrink-0 font-medium tabular-nums ${out ? 'text-clinical' : 'text-gray-900'}`}
      >
        {value.result}
      </span>
      <span className="w-11 shrink-0 truncate text-3xs text-gray-400">{value.unit ?? ''}</span>
      <span className="w-16 shrink-0 text-right text-3xs tabular-nums text-gray-400">
        {value.refText ?? '—'}
      </span>
      <span className="w-14 shrink-0 text-right text-3xs text-clinical">
        {out ? flagText(value.flag) : ''}
      </span>
    </div>
  );
}

function flagText(flag: LabFlag): string {
  if (flag === 'high') return '↑ 高于范围';
  if (flag === 'low') return '↓ 低于范围';
  return '';
}

/** 术语注解 + 免责脚注 */
function TermNotes({ interp, record }: { interp: ReportInterpretation; record: MedicalRecord }) {
  const [ai, setAi] = useState<{
    state: 'idle' | 'loading' | 'done' | 'failed';
    terms: TermHit[];
    message?: string;
  }>({ state: 'idle', terms: [] });

  const terms = useMemo(() => {
    // AI 补的词排在后面：内置词库是核对过的，先看它
    const seen = new Set(interp.terms.map((t) => t.term));
    return [...interp.terms, ...ai.terms.filter((t) => !seen.has(t.term))];
  }, [interp.terms, ai.terms]);

  async function askAi() {
    setAi({ state: 'loading', terms: ai.terms });
    const r = await fetchAiTerms(
      record.ocrText ?? '',
      terms.map((t) => t.term),
    );
    if (r.ok) {
      setAi({ state: 'done', terms: [...ai.terms, ...r.terms] });
    } else {
      setAi({ state: 'failed', terms: ai.terms, message: r.message });
    }
  }

  return (
    <div className="mt-2.5 border-t border-dashed border-gray-200 pt-2">
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xs font-medium text-gray-500">术语注解</span>
        {terms.length > 0 ? (
          <span className="text-3xs text-gray-400">{terms.length} 个</span>
        ) : null}
      </div>

      {terms.length > 0 ? (
        <div className="mt-1.5">
          <Clamp
            items={terms}
            initial={4}
            unit="个术语"
            itemKey={(t) => t.term}
            gap="space-y-1.5"
            render={(t) => <TermRow hit={t} />}
          />
        </div>
      ) : (
        <p className="mt-1 text-xs leading-relaxed text-gray-500">{interp.emptyReason}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void askAi()}
          disabled={ai.state === 'loading'}
          className={
            'no-print rounded-lg border border-dashed border-gray-300 bg-surface/60 px-2 py-1 ' +
            'text-2xs text-gray-600 transition-colors hover:border-brand-300 hover:text-brand-700 ' +
            'disabled:cursor-wait disabled:opacity-60'
          }
        >
          {ai.state === 'loading' ? '补充中…' : '让 AI 补充没收录的术语'}
        </button>
        {ai.state === 'failed' && ai.message ? (
          <span className="text-2xs text-gray-400">{ai.message}</span>
        ) : null}
        {ai.state === 'done' && ai.terms.length === 0 ? (
          <span className="text-2xs text-gray-400">没有补出新的术语</span>
        ) : null}
      </div>

      {/* 脚注常驻：它是这块内容的性质说明，不能折 */}
      <p className="mt-2 text-2xs leading-relaxed text-gray-400">{interp.caveat}</p>
    </div>
  );
}

function TermRow({ hit }: { hit: TermHit }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 rounded bg-brand-50 px-1.5 py-0.5 text-3xs font-medium text-brand-700">
        {hit.term}
      </span>
      <span className="text-xs leading-relaxed text-gray-600">
        {hit.explanation}
        {hit.fromAi ? <span className="ml-1 text-3xs text-gray-400">（AI 补）</span> : null}
      </span>
    </div>
  );
}
