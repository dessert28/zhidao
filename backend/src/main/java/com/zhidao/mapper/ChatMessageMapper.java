package com.zhidao.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhidao.entity.ChatMessage;
import org.apache.ibatis.annotations.Mapper;

/**
 * ChatMessage 数据访问。
 *
 * <p>和 {@link MedicalRecordMapper} 一样，这里只继承 BaseMapper。
 * 用的都是「按 user_id + session_id 过滤 + 排序 + 限制条数」这类单表条件查询，
 * {@code LambdaQueryWrapper} 完全能表达，不需要手写 XML。
 *
 * <p>逻辑删除由 {@code @TableLogic} 自动拼 {@code deleted = 0}，
 * 所以这个 Mapper 里看不到任何 deleted 条件 —— 那不是漏了。
 */
@Mapper
public interface ChatMessageMapper extends BaseMapper<ChatMessage> {
}
