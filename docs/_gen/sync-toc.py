#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
目录页码自校准。

为什么不手写页码：正文一增删，目录就对不上，而这类错误评审一眼就能看见，
却极难靠人工维护 —— 每改一次正文都要重数一遍页。

用法（两步）：
    python _gen/tech-doc.py            # 先出一版（页码显示为 —）
    python _gen/sync-toc.py            # 读 PDF 实际页码，回写 toc-pages.json
    python _gen/tech-doc.py            # 用真实页码再出一版

第二次生成的目录与正文只差页码字符串，版面高度不变，因此页码保持稳定。
"""

import json
import os
import sys

import pypdf

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.dirname(HERE)
PDF = os.path.join(DOCS, "智诊通-技术文档.pdf")
OUT = os.path.join(HERE, "toc-pages.json")

# 章节序号 → 用于在页面文本中定位该章起始的标题串
ANCHORS = [
    ("一", "一、项目概述"),
    ("二", "二、需求分析"),
    ("三", "三、系统架构设计"),
    ("四", "四、AI 技术方案"),
    ("五", "五、核心功能实现"),
    ("六", "六、测试与部署"),
    ("七", "七、总结与展望"),
    ("附录 A", "AI 技术说明"),
    ("附录 B", "创新点说明"),
]


def main() -> int:
    if not os.path.exists(PDF):
        print(f"找不到 PDF：{PDF}", file=sys.stderr)
        return 1

    reader = pypdf.PdfReader(PDF)
    # 目录页自身含有全部章节名，定位时必须跳过，否则每章都会命中第 2 页
    toc_pages = set()
    for i, page in enumerate(reader.pages[:4]):
        text = page.extract_text() or ""
        if "目　录" in text or "目 录" in text:
            toc_pages.add(i)

    found = {}
    for num, anchor in ANCHORS:
        # 第一遍：标题在页首区域。章标题必然新起一页，这个条件最严，
        # 可以挡掉正文里「详见第四章」这类交叉引用的误命中。
        for i, page in enumerate(reader.pages):
            if i in toc_pages:
                continue
            text = page.extract_text() or ""
            if anchor in text[:300]:
                found[num] = i + 1
                break
        if num in found:
            continue
        # 第二遍：附录允许接排（不强制起新页），标题会落在页面中部，
        # 退化为整页搜索。正文里对附录的引用只用「附录 A/B」这种短称，
        # 而这里的 anchor 是全称标题串，不会误命中。
        for i, page in enumerate(reader.pages):
            if i in toc_pages:
                continue
            text = page.extract_text() or ""
            if anchor in text:
                found[num] = i + 1
                break

    missing = [num for num, _ in ANCHORS if num not in found]
    if missing:
        print(f"未能定位章节：{'、'.join(missing)}", file=sys.stderr)

    # 按 PDF 顺序输出，便于人工核对
    ordered = {num: found[num] for num, _ in ANCHORS if num in found}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(ordered, f, ensure_ascii=False, indent=2)

    print(f"共 {len(reader.pages)} 页；已写入 {OUT}")
    for num, page in ordered.items():
        print(f"  {num}　→　第 {page} 页")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
