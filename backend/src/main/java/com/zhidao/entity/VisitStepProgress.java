package com.zhidao.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 就诊流程的某一步进度 —— 患者自己标记的。
 *
 * <p><b>它和时间推算的关系</b>：路线默认按时间倒推出"你该走到第几步"，
 * 那是**估计**。这张表存的是患者实际说了什么。两者冲突时以这张表为准 ——
 * 患者站在抽血窗口前，他比任何时间推算都清楚自己做到哪了。
 *
 * <p>没有"能不能回退"的复杂状态机：患者如果发现自己标错了，
 * 直接删掉这条记录（接口里是 delete）就回到时间推算的默认值。
 * 这比设计一套 UNDO 简单得多，而且符合直觉 ——
 * "我说错了，当我没说"。
 */
@Data
@TableName("visit_step_progress")
public class VisitStepProgress {

    /** 这一步做完了 */
    public static final String STATE_DONE = "DONE";

    /**
     * 这一步跳过了（比如医生说不用做这项检查）。
     *
     * <p>和 DONE 分开存而不是合并：界面上要显示成"已跳过"而不是"已完成"，
     * 否则患者回看时会以为自己做过那项检查。
     */
    public static final String STATE_SKIPPED = "SKIPPED";

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private Long bookingId;

    /**
     * 稳定的步骤标识：`REGISTER` 或 `CLINIC:内分泌科`。
     *
     * <p>不用 place_id：路线本身会随空腹/科室变化重排，
     * 而患者说的是"我做完了检验"这个阶段，不是"我离开了 10 号楼 4 楼"。
     */
    private String navKey;

    private String state;

    private LocalDateTime doneAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
