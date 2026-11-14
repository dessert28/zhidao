/* ------------------------------------------------------------------
 * PDF 文本提取 —— 只处理「文本型 PDF」
 *
 * ============ 边界说清楚 ============
 *
 * PDF 分两种，处理方式完全不同：
 *
 *   文本型 PDF（医院自助机打印的化验单、电子病历导出）
 *     → 内嵌文字对象，可以直接抽文本。**本模块处理这种。**
 *
 *   扫描型 PDF（拍照后转的 PDF、纸质单据扫描件）
 *     → 页面里只有一张图，没有文字对象。要 OCR 才能读。
 *       本模块**提取不到任何文字时明确报错**，不返回空字符串糊弄。
 *
 * 为什么这个区分重要：如果把扫描件当文本型处理，
 * 用户会看到"处理成功"但病历内容是空的，然后以为系统坏了。
 * 明确说"这是扫描件，当前不支持"，用户至少知道该拍清晰点或手动录入。
 *
 * ============ 隐私 ============
 *
 * pdfjs 在**浏览器里**解析，文件不上传。
 * 解析出的文本随后走与 .txt 完全相同的链路：
 * IndexedDB 存原文 → redact() 脱敏 → 只发摘要。
 * ------------------------------------------------------------------ */

/** 提取结果 */
export type PdfExtractResult =
  | { ok: true; text: string; pageCount: number }
  | { ok: false; reason: 'scanned' | 'broken' | 'empty'; message: string };

/**
 * 从 PDF 的 File 对象提取文本。
 *
 * <p>pdfjs 用动态 import：它的体积在数百 KB 量级（含 worker），
 * 不该进首屏包。用户真正选了 PDF 才加载。
 */
export async function extractPdfText(file: File): Promise<PdfExtractResult> {
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    return { ok: false, reason: 'broken', message: '文件读取失败，请重试。' };
  }

  let pageCount = 0;
  let text = '';

  try {
    const pdfjs = await import('pdfjs-dist');

    /*
     * worker 配置。
     *
     * 不配 worker 时 pdfjs 会在主线程解析大文件 —— 病历 PDF 动辄几 MB，
     * 主线程卡住后页面像死了一样。
     *
     * 用 `new URL(..., import.meta.url)` 让 Vite 把 worker 一起打包
     * 并且路径在开发/生产都正确。手写路径在 build 后会 404 ——
     * 这是这类库最常见的集成坑。
     */
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();

    /*
     * 注意：getDocument() 返回的是 loadingTask，不是文档本身。
     * 销毁要在 loadingTask 上调 —— PDFDocumentProxy 上没有 destroy()。
     * 第一版在 doc 上调，TS 直接报"属性不存在"，省了运行时排查。
     */
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      // 病历里可能有加密 PDF（医院系统导出常见），先试空密码
      password: '',
      // 关闭字体警告刷屏
      verbosity: 0,
    });
    const doc = await loadingTask.promise;

    pageCount = doc.numPages;

    // 逐页抽文本。limit 页数上限防止超大文件把内存吃光
    const MAX_PAGES = 30;
    for (let i = 1; i <= Math.min(pageCount, MAX_PAGES); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      /*
       * items 里每个元素是一段文字，可能带 hasEOL。
       * 直接 join('') 会把所有行粘成一坨，中文里更难读；
       * 用 hasEOL 还原换行，保持原来的行结构（检验单是按行对齐的）。
       */
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        if ('hasEOL' in item && item.hasEOL) text += '\n';
      }
      text += '\n';
      page.cleanup();
    }

    await loadingTask.destroy();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 加密 PDF 是最常见的"打不开"原因，单独给话术
    if (/password|encrypted/i.test(msg)) {
      return {
        ok: false,
        reason: 'broken',
        message: '这份 PDF 有密码保护，无法读取。请导出无密码的版本，或手动录入关键信息。',
      };
    }
    return { ok: false, reason: 'broken', message: 'PDF 解析失败，可能文件已损坏。' };
  }

  const cleaned = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  /*
   * 这里是"扫描件判定"的关键。
   *
   * 文本型 PDF 抽出来的字数与页数大致成正比（每页几十到几百字）。
   * 扫描件抽出来是空白或只有极少数水印字。
   *
   * 阈值取每页 10 字：低于这个数就当扫描件。
   * 宁可误判成扫描件让用户手动录入，也不要给一份断断续续的
   * 文本进系统 —— 后者会产生错误的摘要，而摘要会被引用给患者。
   */
  const charsPerPage = pageCount > 0 ? cleaned.length / pageCount : 0;
  if (cleaned.length === 0) {
    return {
      ok: false,
      reason: 'scanned',
      message: `这份 PDF 里没有可提取的文字（${pageCount} 页），应该是扫描件。当前不支持图片识别，请手动录入关键信息，或提供文本版。`,
    };
  }
  if (charsPerPage < 10) {
    return {
      ok: false,
      reason: 'scanned',
      message: `这份 PDF 每页只有约 ${Math.round(charsPerPage)} 个字，大概率是扫描件。当前不支持图片识别，请手动录入关键信息。`,
    };
  }

  return { ok: true, text: cleaned, pageCount };
}
