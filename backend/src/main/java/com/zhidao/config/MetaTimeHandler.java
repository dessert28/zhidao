package com.zhidao.config;

import com.baomidou.mybatisplus.core.handlers.MetaObjectHandler;
import org.apache.ibatis.reflection.MetaObject;
import org.springframework.stereotype.Component;

import java.time.LocalDateTime;

/**
 * 时间字段自动填充。
 *
 * <p>为什么不用数据库的 DEFAULT CURRENT_TIMESTAMP：
 * 数据库默认值只在 INSERT 生效，UPDATE 时需要每条 SQL 都写
 * {@code updated_at = now()}，漏写一处就会出现"更新了但时间没变"。
 * 交给一个地方统一处理，漏不掉。
 */
@Component
public class MetaTimeHandler implements MetaObjectHandler {

    @Override
    public void insertFill(MetaObject metaObject) {
        LocalDateTime now = LocalDateTime.now();
        strictInsertFill(metaObject, "createdAt", LocalDateTime.class, now);
        strictInsertFill(metaObject, "updatedAt", LocalDateTime.class, now);
    }

    @Override
    public void updateFill(MetaObject metaObject) {
        strictUpdateFill(metaObject, "updatedAt", LocalDateTime.class, LocalDateTime.now());
    }
}
