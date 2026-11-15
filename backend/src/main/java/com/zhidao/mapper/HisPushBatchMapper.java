package com.zhidao.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhidao.entity.HisPushBatch;
import org.apache.ibatis.annotations.Mapper;

/** HIS 推送批次（幂等） */
@Mapper
public interface HisPushBatchMapper extends BaseMapper<HisPushBatch> {
}
