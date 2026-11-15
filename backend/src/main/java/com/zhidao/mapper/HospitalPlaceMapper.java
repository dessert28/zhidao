package com.zhidao.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhidao.entity.HospitalPlace;
import org.apache.ibatis.annotations.Mapper;

/**
 * 院内地点 Mapper。
 *
 * <p>没有自定义 SQL：查询都是「按院区 + 类型 + 科室」等值过滤，
 * {@code LambdaQueryWrapper} 足够，写 XML 反而多一处维护点。
 */
@Mapper
public interface HospitalPlaceMapper extends BaseMapper<HospitalPlace> {
}
