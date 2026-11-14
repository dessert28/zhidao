package com.zhidao.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.PastOrPresent;

import java.time.LocalDate;

/**
 * 提交一份就诊记录。
 *
 * <p><b>{@code ocrText} 装的是脱敏后的文本，不是原文。</b>
 * 字段名跟着数据库列走（`medical_record.ocr_text`），
 * 但语义是"脱敏后正文" —— 源文件与原文从不离开患者设备。
 *
 * <p>姓名与身份证之类**刻意没有字段**：schema 里就没有对应的列。
 * 想加一个 {@code rawText}，先回答 docs/09 那个问题：
 * 这个字段被脱库时，患者能不能被识别出来。
 */
public record NewRecordRequest(
        @NotBlank(message = "院区编码不能为空") String hospitalCode,
        @NotNull(message = "就诊日期不能为空")
        @PastOrPresent(message = "就诊日期不能是未来") LocalDate visitDate,
        String department,
        String diagnosisBrief,
        /** 脱敏后正文；可为空（只传摘要时） */
        String ocrText,
        String fileName,
        Long fileSize
) {
}
