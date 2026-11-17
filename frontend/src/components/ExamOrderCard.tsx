/* ------------------------------------------------------------------
 * 检查单卡片 —— 「医生说要做哪些检查」
 *
 * ============ 它为什么在到院页而不是病历页 ============
 *
 * 检查单是**接下来要做的事**，不是"发生过的事"。病历时间轴放的是历史，
 * 把检查单塞进去会让患者以为那是一次就诊记录。
 *
 * 而到院页的整个意义就是"我现在该干什么" —— 检查项目直接决定
 * 去哪几站、要不要空腹，所以它必须出现在这一页，而且要靠前。
 *
 * ============ 为什么要把解析结果给患者看 ============
 *
 * 这是规则匹配，不是医学 NLP。把"我识别到你要做这三项"摆出来，
 * 患者一眼就能发现漏没漏、错没错。反过来，如果只在内部用、
 * 界面上不显示，识别错了患者永远不知道，只能被指错地方。
 * ------------------------------------------------------------------ */

import { Link } from 'react-router-dom';
import type { LocalRecord } from '../lib/db/records';
import type { ParsedExam } from '../lib/exam/order-parse';
import { planExamSequence } from '../lib/exam/sequence';

/** 把 LocalRecord 里的宽松类型转回 ParsedExam */
export function toParsedExams(items: NonNullable<LocalRecord['examItems']>): ParsedExam[] {
  return items.map((i) => ({
    name: i.name,
    placeType: (i.placeType === 'LAB' || i.placeType === 'EXAM' ? i.placeType : 'OTHER') as
      | 'LAB'
      | 'EXAM'
      | 'OTHER',
    fasting: i.fasting,
    evidence: i.evidence,
  }));
}

export function ExamOrderCard({ record }: { record: LocalRecord | null }) {
  /* ---------- 还没上传：告诉患者这一步能做什么 ---------- */
  if (!record) {
    return (
      <section className="rounded-xl border border-dashed border-gray-300 bg-surface p-4">
        <h2 className="text-sm font-medium text-gray-700">医生开了检查单？</h2>
        <p className="mt-1 text-xs leading-relaxed text-gray-500">
          上传之后，上面的"现在去哪"会按检查项目重算 ——
          要拍片还是会直接去抽血、要不要空腹，都会跟着变。
        </p>
        <Link
          to="/records"
          className="mt-2.5 inline-flex items-center rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700"
        >
          去「我的病历」上传检查单 →
        </Link>
      </section>
    );
  }

  const items = record.examItems ? toParsedExams(record.examItems) : [];

  /* ---------- 上传了但没识别出项目：如实说 ---------- */
  if (items.length === 0) {
    return (
      <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <h2 className="text-sm font-medium text-amber-900">已上传，但没认出检查项目</h2>
        <p className="mt-1 text-xs leading-relaxed text-amber-800">
          这张检查单可能拍得比较糊，或者格式不常见。下面的指引仍按科室的通用流程给，
          <b className="font-medium">请以上面的检查单原文为准</b>，
          到院后也可以直接问分诊台。
        </p>
        <p className="mt-1.5 text-xs text-amber-700">文件名：{record.fileName}</p>
      </section>
    );
  }

  /* ---------- 识别成功 ---------- */
  const hasFasting = items.some((i) => i.fasting === true);
  /*
   * 顺序建议放在项目列表之前 —— 患者看完"要做哪些"，紧接着的问题
   * 就是"先做哪个"。列表本身仍按检查单原顺序展示，方便对照原文。
   */
  const steps = planExamSequence(items);
  /** 空腹状态未知的项目名，单独提示去问分诊台 */
  const unknownNames = steps.filter((s) => s.needsConfirmation).map((s) => s.exam.name);
  const unknownFasting = unknownNames.length > 0;

  return (
    <section className="rounded-xl border border-brand-200 bg-surface p-4">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-medium text-gray-800">这次要做的检查</h2>
        <span className="text-xs text-gray-400">{items.length} 项</span>
      </div>

      {/* 建议顺序：编号 + 理由都是给患者看的，不是内部序号 */}
      <div className="mt-3 rounded-lg border border-brand-100 bg-brand-50/60 px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-medium text-brand-800">建议顺序</span>
          <span className="text-2xs text-brand-700">按流程先后排，不是医学判断</span>
        </div>
        <ol className="mt-1.5 space-y-1.5">
          {steps.map((s) => (
            <li key={`${s.order}-${s.exam.name}`} className="flex gap-2">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-action text-3xs font-medium text-white">
                {s.order}
              </span>
              <div className="min-w-0">
                <div className="text-xs text-gray-800">
                  {s.exam.name}
                  {s.needsConfirmation ? (
                    <span className="ml-1.5 rounded bg-surface px-1 py-0.5 text-3xs text-amber-700">
                      待确认
                    </span>
                  ) : null}
                </div>
                <p className="text-2xs leading-relaxed text-gray-600">{s.reason}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      <ul className="mt-3 space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex items-baseline gap-2 text-sm">
            <span className="text-gray-800">{it.name}</span>
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-2xs text-gray-600">
              {it.placeType === 'LAB' ? '抽血' : it.placeType === 'EXAM' ? '检查' : '其他'}
            </span>
            {it.fasting === true ? (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-2xs text-amber-700">
                需空腹
              </span>
            ) : it.fasting === false ? (
              <span className="rounded bg-gray-50 px-1.5 py-0.5 text-2xs text-gray-500">
                无需空腹
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      {hasFasting ? (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          有需要空腹的项目，检查前请勿进食。已经吃过东西的话，抽血和部分检查要改天再来。
        </p>
      ) : null}

      {/*
        不知道要不要空腹时必须单独提示，而且要点名是哪几项。
        沉默会让患者默认"不用空腹"，而这恰恰是最容易白跑一趟的原因；
        只说"有几项"也不行 —— 患者没法知道该去问哪一项。
        "怎么排"一起问，是因为这类项目的顺序同样取决于医生的安排。
      */}
      {unknownFasting ? (
        <p className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-600">
          <b className="font-medium text-gray-700">{unknownNames.join('、')}</b>
          {' '}要不要空腹、怎么排，请先问分诊台 —— 空腹往往不能补做，白跑一趟很常见。
        </p>
      ) : null}

      <p className="mt-2 text-xs leading-relaxed text-gray-400">
        依据「{record.fileName}」自动识别。上面的指引已按这些项目重算；
        顺序建议只是流程上的先后，内镜、增强造影等有创检查以医生和分诊台的安排为准。
        如果识别有出入，以检查单原文为准。
      </p>
    </section>
  );
}
