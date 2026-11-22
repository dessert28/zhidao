package com.zhidao.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhidao.entity.SysNotice;
import org.apache.ibatis.annotations.Mapper;

/**
 * 公告数据访问。
 *
 * <p>全部查询都是单表条件 + 分页，BaseMapper 就够了，
 * 不为"分层好看"再手写一遍 CRUD。
 */
@Mapper
public interface SysNoticeMapper extends BaseMapper<SysNotice> {
}
