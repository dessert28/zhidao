#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成《智诊通》技术文档 DOCX。

设计目标（对着比赛评分表写）：
  · 严格覆盖官方七节：项目概述 / 需求分析 / 系统架构设计 /
    AI 技术方案 / 核心功能实现 / 测试与部署 / 总结与展望
  · 额外满足两条硬要求：AI 技术说明（选型/集成/优化）、创新点说明
  · 控制在 30 页以内（官方上限）

写作原则：
  · 所有数字来自实测（测试数、代码行数、接口数），不编
  · 以优势陈述为主线，边界用"设计取舍/演进方向"表述，不做自我否定清单
  · 每一处技术claim都指向具体代码位置，评审可查

字体：Windows 微软雅黑 + 等宽 Consolas；中文需显式设 eastAsia。
"""

from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

# ---------------- 配色（与产品品牌色一致：teal 700 #0f766e） ----------------
BRAND = RGBColor(0x0F, 0x76, 0x6E)
DARK = RGBColor(0x1F, 0x29, 0x37)
GRAY = RGBColor(0x4B, 0x55, 0x63)
MUTED = RGBColor(0x6B, 0x72, 0x80)

CN_FONT = "微软雅黑"
MONO_FONT = "Consolas"


# ============================================================
# 基础排版工具
# ============================================================

def set_run_font(run, name=CN_FONT, size=None, bold=None, color=None):
    """设置 run 的字体。中文必须同时设置 eastAsia，否则 Word 用默认宋体。"""
    run.font.name = name
    r = run._element
    rPr = r.get_or_add_rPr()
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = OxmlElement("w:rFonts")
        rPr.append(rFonts)
    rFonts.set(qn("w:ascii"), name)
    rFonts.set(qn("w:hAnsi"), name)
    rFonts.set(qn("w:eastAsia"), name)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color is not None:
        run.font.color.rgb = color


def add_par(doc, text="", size=10.2, bold=False, color=None, align=None,
            space_before=0, space_after=4, indent=None, line=1.31, font=CN_FONT):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(space_before)
    pf.space_after = Pt(space_after)
    pf.line_spacing = line
    if indent is not None:
        pf.first_line_indent = Cm(indent)
    if align is not None:
        p.alignment = align
    if text:
        # 正文同样支持 **加粗** 与 `等宽`；直接整段塞一个 run 会让星号原样渲染
        if "**" in text or "`" in text:
            _add_rich(p, text, size, color if color is not None else DARK)
            if bold:
                for r in p.runs:
                    r.bold = True
        else:
            run = p.add_run(text)
            set_run_font(run, font, size, bold, color)
    return p


def add_heading(doc, text, level=1):
    """自定义标题：level 1 带品牌色与上间距，level 2 带左侧色条效果。"""
    if level == 1:
        p = add_par(doc, "", space_before=13, space_after=6)
        run = p.add_run(text)
        set_run_font(run, CN_FONT, 16, True, BRAND)
        # 底部分隔线
        pPr = p._element.get_or_add_pPr()
        pbdr = OxmlElement("w:pBdr")
        bottom = OxmlElement("w:bottom")
        bottom.set(qn("w:val"), "single")
        bottom.set(qn("w:sz"), "6")
        bottom.set(qn("w:space"), "4")
        bottom.set(qn("w:color"), "0F766E")
        pbdr.append(bottom)
        pPr.append(pbdr)
        p.paragraph_format.keep_with_next = True
        return p
    if level == 2:
        p = add_par(doc, "", space_before=12, space_after=5)
        run = p.add_run(text)
        set_run_font(run, CN_FONT, 12.5, True, DARK)
        # 标题不能孤零零落在页底，必须与后文同页
        p.paragraph_format.keep_with_next = True
        return p
    p = add_par(doc, "", space_before=7, space_after=3)
    run = p.add_run(text)
    set_run_font(run, CN_FONT, 11, True, GRAY)
    p.paragraph_format.keep_with_next = True
    return p


def add_bullet(doc, text, size=10.5, indent=0.55):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.left_indent = Cm(indent)
    pf.space_before = Pt(0)
    pf.space_after = Pt(3)
    pf.line_spacing = 1.5
    run = p.add_run("· ")
    set_run_font(run, CN_FONT, size, False, BRAND)
    # 支持 **加粗** 片段
    _add_rich(p, text, size)
    return p


def _add_rich(p, text, size=10.5, color=DARK):
    """把 **xx** 渲染成加粗，`xx` 渲染成等宽。"""
    import re
    tokens = re.split(r"(\*\*[^*]+\*\*|`[^`]+`)", text)
    for t in tokens:
        if not t:
            continue
        if t.startswith("**") and t.endswith("**") and len(t) > 4:
            run = p.add_run(t[2:-2])
            set_run_font(run, CN_FONT, size, True, color)
        elif t.startswith("`") and t.endswith("`") and len(t) > 2:
            run = p.add_run(t[1:-1])
            set_run_font(run, MONO_FONT, size - 1, False, RGBColor(0x0F, 0x76, 0x6E))
        else:
            run = p.add_run(t)
            set_run_font(run, CN_FONT, size, False, color)


def add_code_block(doc, code, size=8.5):
    """浅底代码块（用单元格实现底色 + 边框）。"""
    tbl = doc.add_table(rows=1, cols=1)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = tbl.cell(0, 0)
    shade(cell, "F3F4F6")
    set_cell_borders(cell, "E5E7EB")
    cell.text = ""
    lines = code.strip("\n").split("\n")
    # 短代码块禁止跨页：被切成两半比换页更难看。
    # 长块（架构图等）一页放不下，只能允许跨页。
    if len(lines) <= 16:
        _no_split_row(tbl.rows[0])
    for i, line in enumerate(lines):
        p = cell.paragraphs[0] if i == 0 else cell.add_paragraph()
        pf = p.paragraph_format
        pf.space_before = Pt(0)
        pf.space_after = Pt(0)
        pf.line_spacing = 1.25
        run = p.add_run(line if line else " ")
        set_run_font(run, MONO_FONT, size, False, RGBColor(0x37, 0x41, 0x51))
    # 单元格内边距
    set_cell_margins(cell, 120, 160)


def shade(cell, hex_color):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_color)
    tcPr.append(shd)


def set_cell_borders(cell, hex_color="D1D5DB", sz="4"):
    tcPr = cell._tc.get_or_add_tcPr()
    borders = OxmlElement("w:tcBorders")
    for edge in ("top", "left", "bottom", "right"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), sz)
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), hex_color)
        borders.append(el)
    tcPr.append(borders)


def set_cell_margins(cell, top=30, left=100):
    tcPr = cell._tc.get_or_add_tcPr()
    mar = OxmlElement("w:tcMar")
    for k, v in (("top", top), ("bottom", top), ("left", left), ("right", left)):
        el = OxmlElement(f"w:{k}")
        el.set(qn("w:w"), str(v))
        el.set(qn("w:type"), "dxa")
        mar.append(el)
    tcPr.append(mar)


def _no_split_row(row):
    """
    禁止表格行跨页断裂。
    不加这个属性时，Word 会把同一行里的文字切到两页，
    实测出现过「只保留最近若干轮原文，更早内容压缩」被切成
    「…更早内容压」+「缩为摘要」两半的荒谬排版。
    """
    trPr = row._tr.get_or_add_trPr()
    cant = OxmlElement("w:cantSplit")
    cant.set(qn("w:val"), "true")
    trPr.append(cant)


def _repeat_header(row):
    """表头在跨页时重复出现，方便读者对照列。"""
    trPr = row._tr.get_or_add_trPr()
    el = OxmlElement("w:tblHeader")
    el.set(qn("w:val"), "true")
    trPr.append(el)


def add_table(doc, headers, rows, widths=None, size=8.6, header_bg="0F766E"):
    """三线感表格：深色表头 + 浅色分隔。"""
    tbl = doc.add_table(rows=1, cols=len(headers))
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl.autofit = False

    hdr = tbl.rows[0]
    _no_split_row(hdr)
    _repeat_header(hdr)
    for i, h in enumerate(headers):
        cell = hdr.cells[i]
        cell.text = ""
        shade(cell, header_bg)
        set_cell_margins(cell)
        p = cell.paragraphs[0]
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        run = p.add_run(h)
        set_run_font(run, CN_FONT, size, True, RGBColor(0xFF, 0xFF, 0xFF))

    for r_idx, row in enumerate(rows):
        tr = tbl.add_row()
        _no_split_row(tr)
        cells = tr.cells
        for i, val in enumerate(row):
            cell = cells[i]
            cell.text = ""
            if r_idx % 2 == 1:
                shade(cell, "F9FAFB")
            set_cell_margins(cell)
            p = cell.paragraphs[0]
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = 1.22
            _add_rich(p, str(val), size)

    if widths:
        for i, w in enumerate(widths):
            for row in tbl.rows:
                row.cells[i].width = Cm(w)
    return tbl


def add_callout(doc, title, body, bg="F0FDFA", border="99F6E4", title_color=BRAND):
    """强调框：用于结论、关键取舍。不跨页断裂。"""
    tbl = doc.add_table(rows=1, cols=1)
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = tbl.cell(0, 0)
    shade(cell, bg)
    set_cell_borders(cell, border, "8")
    set_cell_margins(cell, 120, 160)
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(3)
    run = p.add_run(title)
    set_run_font(run, CN_FONT, 10, True, title_color)
    p2 = cell.add_paragraph()
    p2.paragraph_format.space_before = Pt(0)
    p2.paragraph_format.space_after = Pt(0)
    p2.paragraph_format.line_spacing = 1.5
    _add_rich(p2, body, 9.5)
    _no_split_row(tbl.rows[0])


def page_break(doc):
    doc.add_page_break()


def add_spacer(doc, pt=6):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(0)
    run = p.add_run("")
    set_run_font(run, CN_FONT, pt)


def add_footer(section, text):
    footer = section.footer
    p = footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(text)
    set_run_font(run, CN_FONT, 8.5, False, MUTED)


def add_page_number_footer(section, left_text):
    """页脚左文右页码。"""
    footer = section.footer
    p = footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(left_text + "    第 ")
    set_run_font(run, CN_FONT, 8.5, False, MUTED)
    _add_field(p, "PAGE")
    run2 = p.add_run(" 页")
    set_run_font(run2, CN_FONT, 8.5, False, MUTED)


def _add_field(paragraph, field_code):
    run = paragraph.add_run()
    fldChar1 = OxmlElement("w:fldChar")
    fldChar1.set(qn("w:fldCharType"), "begin")
    instrText = OxmlElement("w:instrText")
    instrText.set(qn("xml:space"), "preserve")
    instrText.text = field_code
    fldChar2 = OxmlElement("w:fldChar")
    fldChar2.set(qn("w:fldCharType"), "end")
    run._r.append(fldChar1)
    run._r.append(instrText)
    run._r.append(fldChar2)
