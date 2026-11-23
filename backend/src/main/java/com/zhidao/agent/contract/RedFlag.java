package com.zhidao.agent.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * 红线急症标记 —— 对照 contract.ts 的 RedFlag。
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonInclude(JsonInclude.Include.NON_NULL)
public class RedFlag {
    /** chest_pain | stroke | dyspnea | consciousness | hemorrhage */
    private String type;
    /** 可执行的下一步动作，不是免责声明 */
    private String guidance;
}
