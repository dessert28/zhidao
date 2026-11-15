package com.zhidao.his;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.entity.HospitalCredential;
import com.zhidao.entity.HospitalPlace;
import com.zhidao.entity.HisPushBatch;
import com.zhidao.mapper.HospitalCredentialMapper;
import com.zhidao.mapper.HospitalPlaceMapper;
import com.zhidao.mapper.HisPushBatchMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * HIS 接入服务 —— 院方把官方数据推给我们。
 *
 * <h3>这一层解决什么问题</h3>
 *
 * <p>在此之前，院内地点是我们从公开来源整理的，标 REAL 但也只是"公开可查"，
 * 不是院方自己的系统给的数据。有了这个接口，医院 HIS 一方可以
 * 直接把科室、楼层、窗口、号源推过来 —— 这才是"官方信息"的定义。
 *
 * <h3>三条必须守住的规则</h3>
 *
 * <ol>
 *   <li><b>验签失败不进入业务逻辑</b>：签名错就立刻拒绝，
 *       不查库、不解析 body —— 减少被探测的攻击面</li>
 *   <li><b>院方只能写自己的院区</b>：凭据绑定了 hospitalCode，
 *       推送内容里的院区必须与之相同。否则 A 医院可以改 B 医院的导航</li>
 *   <li><b>幂等</b>：同一个 batchId 只处理一次。院方重试是常态，
 *       不幂等会导致数据重复</li>
 * </ol>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class HisIngestService {

    private final HospitalCredentialMapper credentialMapper;
    private final HospitalPlaceMapper placeMapper;
    private final HisPushBatchMapper batchMapper;

    /** 允许的地点类型，与 HospitalNavService 的 STAGE_ORDER 保持一致 */
    private static final Set<String> ALLOWED_TYPES = Set.of(
            "REGISTER", "LAB", "CLINIC", "EXAM", "PHARMACY", "CASHIER", "REPORT", "OTHER");

    /* ============================ 验签 ============================ */

    /** 验签结果 */
    public record AuthResult(boolean ok, HospitalCredential credential, String reason) {
        static AuthResult fail(String reason) {
            return new AuthResult(false, null, reason);
        }
    }

    /**
     * 校验一次院方调用。
     *
     * <p>顺序刻意是：凭据 → 时间戳 → 签名。先做便宜的检查，
     * 签名计算放最后 —— 签名要算 HMAC，相对贵。
     * 更重要的是：**凭据不存在时不参与验签**，避免用错误的 secret
     * 反复试探。
     */
    public AuthResult authenticate(
            String appKey, String signature, String timestamp, String nonce,
            String method, String path, String body) {

        if (appKey == null || appKey.isBlank()) {
            return AuthResult.fail("缺少 appKey");
        }

        HospitalCredential cred = credentialMapper.selectOne(
                new LambdaQueryWrapper<HospitalCredential>()
                        .eq(HospitalCredential::getAppKey, appKey)
                        .eq(HospitalCredential::getEnabled, true)
                        .last("LIMIT 1"));

        if (cred == null) {
            return AuthResult.fail("appKey 无效或已停用");
        }

        if (timestamp == null || signature == null || nonce == null) {
            return AuthResult.fail("缺少签名头：X-Timestamp / X-Nonce / X-Signature");
        }

        long ts;
        try {
            ts = Long.parseLong(timestamp.trim());
        } catch (NumberFormatException e) {
            return AuthResult.fail("X-Timestamp 必须是秒级时间戳");
        }

        long now = Instant.now().getEpochSecond();
        if (!HisSignature.timestampAcceptable(ts, now)) {
            /*
             * 时间窗的作用是防重放。偏差 5 分钟通常是时钟不同步，
             * 直接把两个时间都返回，让院方能自己定位问题 ——
             * 只说"时间戳无效"会让人查很久。
             */
            return AuthResult.fail(
                    "请求时间戳超出允许范围（服务器时间 " + now + "，请求 " + ts + "，允许偏差 "
                            + HisSignature.TIMESTAMP_TOLERANCE_SECONDS + " 秒）");
        }

        if (!HisSignature.verify(cred.getAppSecret(), method, path, timestamp, nonce, body, signature)) {
            // 不记录应得的签名（那等于把 secret 泄露到日志里）
            return AuthResult.fail("签名校验失败");
        }

        // 记录最后调用时间；失败不影响请求本身
        try {
            cred.setLastUsedAt(LocalDateTime.now());
            credentialMapper.updateById(cred);
        } catch (RuntimeException e) {
            log.warn("[his] 更新 last_used_at 失败 appKey={}", appKey, e);
        }

        return new AuthResult(true, cred, "");
    }

    /* ============================ 推送院内地点 ============================ */

    /** 院方推送的一条地点 */
    public record PlaceItem(
            String placeType,
            String department,
            String name,
            String building,
            String floor,
            String directions,
            String openHours,
            Integer estMinutes,
            Integer sortOrder
    ) {
    }

    /** 推送结果 */
    public record IngestResult(
            boolean ok,
            boolean duplicated,
            int applied,
            String message
    ) {
    }

    /**
     * 接收院方推送的院内地点。
     *
     * <p><b>整批替换而不是逐条 upsert</b>：院方推送的是"我们现在的完整地点清单"，
     * 逐条 upsert 会让已下线的地点残留（比如三楼的抽血窗口搬走了，
     * 新数据里没有它，但它还在库里，患者仍会被指引到旧位置）。
     * 整批替换的语义更接近院方的意图。
     *
     * <p>代价：如果院方分多次推（每次推一部分），前一批会被后一批覆盖。
     * 所以约定是**一次推送必须是完整清单**，并在接口文档里写明。
     *
     * @param hospitalCode 凭据绑定的院区（不是请求里的，防止越权）
     * @param batchId 院方批次号，用于幂等
     * @param items 完整地点清单
     */
    @Transactional
    public IngestResult pushPlaces(String hospitalCode, String batchId, List<PlaceItem> items) {
        if (batchId == null || batchId.isBlank()) {
            return new IngestResult(false, false, 0, "缺少 batchId（幂等必需）");
        }
        if (items == null || items.isEmpty()) {
            /*
             * 空清单是危险的：整批替换语义下，空清单等于"删光这家医院的所有地点"。
             * 院方不太可能真的要清空，更可能是推送出错。
             * 所以空清单直接拒绝，让院方明确表达"清空"的意图（未来可以加专门接口）。
             */
            return new IngestResult(false, false, 0,
                    "地点清单为空。整批替换语义下空清单会清空该院区所有导航，已拒绝。"
                            + "如确需清空请使用专门的下线接口。");
        }

        // 幂等：同一 batchId 已处理过就直接返回，不再写库
        HisPushBatch existing = batchMapper.selectOne(
                new LambdaQueryWrapper<HisPushBatch>()
                        .eq(HisPushBatch::getHospitalCode, hospitalCode)
                        .eq(HisPushBatch::getBatchId, batchId)
                        .last("LIMIT 1"));
        if (existing != null) {
            return new IngestResult(true, true, existing.getAppliedCount(),
                    "该批次已处理过（batchId=" + batchId + "），未重复写入");
        }

        // 校验每条数据的类型与必填项
        List<HospitalPlace> toInsert = new ArrayList<>(items.size());
        for (int i = 0; i < items.size(); i++) {
            PlaceItem it = items.get(i);
            if (it.placeType() == null || !ALLOWED_TYPES.contains(it.placeType())) {
                return new IngestResult(false, false, 0,
                        "第 " + (i + 1) + " 条的 placeType 非法：" + it.placeType()
                                + "，允许值 " + ALLOWED_TYPES);
            }
            if (it.name() == null || it.name().isBlank()) {
                return new IngestResult(false, false, 0, "第 " + (i + 1) + " 条缺少 name");
            }

            HospitalPlace p = new HospitalPlace();
            p.setHospitalCode(hospitalCode);
            p.setPlaceType(it.placeType());
            // 空字符串统一转成 null，避免"科室=空串"与"科室=null"两种空值并存
            p.setDepartment(blankToNull(it.department()));
            p.setName(it.name());
            p.setBuilding(it.building());
            p.setFloor(it.floor());
            p.setDirections(it.directions());
            p.setOpenHours(it.openHours());
            p.setEstMinutes(it.estMinutes());
            p.setSortOrder(it.sortOrder() == null ? 100 : it.sortOrder());
            /*
             * 院方推来的数据就是官方数据 —— 这是 REAL 的来源。
             * 之前 REAL 只表示"公开来源可查"，现在这个字段有了更强的含义。
             */
            p.setDataQuality("REAL");
            toInsert.add(p);
        }

        // 整批替换：先清掉该院区的旧地点（逻辑删除，保留历史）
        placeMapper.delete(new LambdaQueryWrapper<HospitalPlace>()
                .eq(HospitalPlace::getHospitalCode, hospitalCode));

        for (HospitalPlace p : toInsert) {
            placeMapper.insert(p);
        }

        HisPushBatch rec = new HisPushBatch();
        rec.setHospitalCode(hospitalCode);
        rec.setBatchId(batchId);
        rec.setPushType("PLACES");
        rec.setItemCount(items.size());
        rec.setAppliedCount(toInsert.size());
        rec.setResult("APPLIED");
        rec.setMessage("整批替换完成");
        batchMapper.insert(rec);

        log.info("[his] 院方推送地点 hospital={} batch={} 条数={}",
                hospitalCode, batchId, toInsert.size());

        return new IngestResult(true, false, toInsert.size(),
                "已替换该院区全部导航地点，共 " + toInsert.size() + " 条");
    }

    /* ============================ 辅助 ============================ */

    /** 按 appKey 找院区，供审计用 */
    public Optional<String> hospitalOf(String appKey) {
        HospitalCredential c = credentialMapper.selectOne(
                new LambdaQueryWrapper<HospitalCredential>()
                        .eq(HospitalCredential::getAppKey, appKey)
                        .last("LIMIT 1"));
        return Optional.ofNullable(c).map(HospitalCredential::getHospitalCode);
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }
}
