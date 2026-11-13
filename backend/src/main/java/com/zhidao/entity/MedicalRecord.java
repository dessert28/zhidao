package com.zhidao.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalDateTime;

/**
 * 就诊记录。
 *
 * <p><b>关于 {@code ocrText}</b>：这里存的是<b>脱敏后</b>的文本。
 * 扫描件、照片原文只存在于患者的浏览器 IndexedDB 里，
 * 这张表连"存原文"的字段都没有 —— 不是忘了加，是故意不加。
 *
 * <p>如果哪天有人要往这里加一个 {@code rawFileUrl} 或 {@code originalText}，
 * 需要先回答一个问题：这个字段被脱库时，患者能不能被识别出来？
 * 如果答案是能，就不能加。
 */
@Data
@TableName("medical_record")
public class MedicalRecord {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    /** 跨院标识，非外键。见 docs/09 硬约束之三 */
    private String hospitalCode;

    private LocalDate visitDate;

    private String department;

    /** 脱敏后的诊断摘要 */
    private String diagnosisBrief;

    /** 脱敏后文本；原文不落库 */
    private String ocrText;

    /** 文件名保留：患者需要看到"我上传过什么" */
    private String fileName;

    private Long fileSize;

    /** UPLOAD（上传识别） / MANUAL（手动录入） */
    private String source;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
