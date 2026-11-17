/* ------------------------------------------------------------------
 * 病历原文的本地存储（IndexedDB）
 * 依据：docs/09「原文不进 MySQL」、docs/08 §1 隐私架构
 *
 * ============ 这一层是整个隐私架构的物理实现 ============
 *
 * README §5.3 承诺"病历原文只存浏览器 IndexedDB，服务端连原文的数据列都没有"。
 * 在写这个文件之前，那句承诺**只是文档里的一句话** ——
 * 因为从来没有代码把原文存下来过。现在它有了落点。
 *
 * 三条必须守住的规矩：
 *
 * 1. **只写本地，永不上传。**
 *    这个模块没有任何网络调用。想传也传不出去 —— 这是刻意的设计，
 *    而不是"约定不传"。评审如果问"你怎么保证原文不上传"，
 *    答案是"那一层根本没有网络代码"。
 *
 * 2. **存的是原文，不是脱敏版。**
 *    反直觉但必要：脱敏文本可以由原文再算一次，反过来不行。
 *    患者需要看到"我上传的是什么"，也得能重新导出。
 *
 * 3. **每一份都记元信息。**
 *    文件名、大小、上传时间、处理状态 —— 患者要知道"我上传过什么"，
 *    这是知情权，不是可选项。
 * ------------------------------------------------------------------ */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/** 一份本地病历 */
export interface LocalRecord {
  /** 主键，本地生成 */
  id: string;
  /** 原始文件名 */
  fileName: string;
  /** 字节数 */
  fileSize: number;
  /** MIME 类型 */
  mimeType: string;
  /** 上传时间（epoch ms） */
  uploadedAt: number;
  /** 原文（文本形式）。图片/PDF 暂存文件名与大小，正文走 OCR 后再填 */
  rawText: string;
  /** 患者填的就诊日期，YYYY-MM-DD */
  visitDate: string;
  /** 院区编码 */
  hospitalCode: string;
  /** 科室（可选） */
  department: string;

  /**
   * 这是什么类型的材料。
   *
   * <p>加这个字段的原因：医生开的**检查单**和既往**病历**用途完全不同 ——
   * 病历是"发生过的事"，检查单是"接下来要做的事"。
   * 前者进时间轴，后者要驱动到院指引。混成一种，
   * 时间轴上会出现一条"今天开的检查单"看起来像一次就诊记录。
   *
   * <p>缺省视为 `record`：这个字段是后加的，老数据里没有，
   * 把它们当成普通病历是安全的默认值。
   */
  kind?: 'record' | 'examOrder';

  /**
   * 检查单解析出的项目（仅 kind === 'examOrder' 时有值）。
   *
   * <p>存本地而不是只存原文：到院页每次渲染都要用它决定"去哪几站"，
   * 每次都重新解析一遍既慢又会因为词典更新而前后不一致。
   * 解析结果的类型是 `ParsedExam[]`，这里用宽类型避免 db 层依赖 exam 模块。
   */
  examItems?: Array<{
    name: string;
    placeType: string;
    fasting: boolean | null;
    evidence: string;
  }>;
}

interface ZhidaoDB extends DBSchema {
  records: {
    key: string;
    value: LocalRecord;
    indexes: { byUploadedAt: number };
  };
}

const DB_NAME = 'zhidao-local';
const DB_VERSION = 1;
const STORE = 'records';

let dbPromise: Promise<IDBPDatabase<ZhidaoDB> | null> | null = null;

/**
 * 打开数据库。
 *
 * <p>失败时返回 null 而不是抛 —— 隐私模式下 IndexedDB 可能被禁用，
 * 那种情况下上传功能应当**明确不可用**，而不是让整页崩掉。
 */
function getDB(): Promise<IDBPDatabase<ZhidaoDB> | null> {
  dbPromise ??= openDB<ZhidaoDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const store = db.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('byUploadedAt', 'uploadedAt');
    },
  }).catch(() => null);

  return dbPromise;
}

/** 本地存储是否可用 */
export async function isAvailable(): Promise<boolean> {
  return (await getDB()) !== null;
}

/** 保存一份原文，返回生成的 id */
export async function saveRecord(input: Omit<LocalRecord, 'id' | 'uploadedAt'>): Promise<string | null> {
  const db = await getDB();
  if (!db) return null;

  const id = crypto.randomUUID();
  await db.put(STORE, { ...input, id, uploadedAt: Date.now() });
  return id;
}

/** 按上传时间倒序列出 */
export async function listRecords(): Promise<LocalRecord[]> {
  const db = await getDB();
  if (!db) return [];
  const all = await db.getAllFromIndex(STORE, 'byUploadedAt');
  return all.reverse();
}

/** 取一份原文 */
export async function getRecord(id: string): Promise<LocalRecord | undefined> {
  const db = await getDB();
  return db?.get(STORE, id);
}

/**
 * 取「最近一张检查单」。
 *
 * <p>到院页用它决定接下来去哪几站。只取一张而不是全部：
 * 医生这次开的检查单才是当前有效的，翻出上个月的那张
 * 会让指引混进已经做完的项目。
 *
 * @param hospitalCode 可选，限定院区。不同院区的检查单不该互相干扰
 * @returns 没有检查单时返回 undefined
 */
export async function latestExamOrder(
  hospitalCode?: string,
): Promise<LocalRecord | undefined> {
  const all = await listRecords();
  return all.find(
    (r) => r.kind === 'examOrder' && (!hospitalCode || r.hospitalCode === hospitalCode),
  );
}

/** 删除 */
export async function deleteRecord(id: string): Promise<void> {
  const db = await getDB();
  await db?.delete(STORE, id);
}

/** 清空（"彻底删除我的数据"用） */
export async function clearAll(): Promise<void> {
  const db = await getDB();
  await db?.clear(STORE);
}

/** 占用空间估算（给"你占用了多少本地空间"用） */
export async function localUsage(): Promise<{ count: number; bytes: number }> {
  const records = await listRecords();
  return {
    count: records.length,
    bytes: records.reduce((sum, r) => sum + r.fileSize, 0),
  };
}
