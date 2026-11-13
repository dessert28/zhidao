package com.zhidao.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhidao.entity.PatientProfile;
import org.apache.ibatis.annotations.Mapper;

/**
 * PatientProfile 数据访问。
 *
 * <p>继承 MyBatis-Plus 的 BaseMapper 即可获得单表 CRUD；
 * 复杂查询（跨院对比、到期扫描）写在对应的 XML 或 @Select 里，
 * 不要为了"看起来分层清晰"给每张表都手写一遍 CRUD。
 */
@Mapper
public interface PatientProfileMapper extends BaseMapper<PatientProfile> {
}
