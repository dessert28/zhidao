package com.zhidao.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.zhidao.entity.HospitalCredential;
import org.apache.ibatis.annotations.Mapper;

/** 院方接入凭据 */
@Mapper
public interface HospitalCredentialMapper extends BaseMapper<HospitalCredential> {
}
