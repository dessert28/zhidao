package com.zhidao.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhidao.entity.VisitStepProgress;
import org.apache.ibatis.annotations.Mapper;

/**
 * VisitStepProgress 数据访问。
 *
 * <p>单表 CRUD 够用：读取全是「按 booking_id 取这一单的全部进度」，
 * 写入是「同一 nav_key 覆盖」，都可以用 LambdaQueryWrapper + BaseMapper 完成。
 */
@Mapper
public interface VisitStepProgressMapper extends BaseMapper<VisitStepProgress> {
}
