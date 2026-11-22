package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.common.PageResult;
import com.zhidao.dto.AdminHospitalRequest;
import com.zhidao.dto.AdminPlaceRequest;
import com.zhidao.service.AdminHospitalService;
import com.zhidao.vo.AdminHospitalView;
import com.zhidao.vo.AdminPlaceView;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 管理端 · 院区与院内地点。
 *
 * <p>类级路径是 {@code /api/admin} 而不是 {@code /api/admin/hospitals}：
 * 删除地点是 {@code DELETE /api/admin/places/{id}}，它不挂在某个院区下面。
 * Spring 的方法级路径只会追加到类级路径后面，不能覆盖，
 * 所以另起一个类级前缀反而要拆成两个 Controller。
 *
 * <p><b>院区编码不可改</b>：PUT 的编码以路径参数为准，请求体里的
 * {@code hospitalCode} 会被忽略。预约单与病历都按这个编码跨表引用，
 * 允许改编码等于允许把历史记录静默指向另一家医院。
 */
@RestController
@RequestMapping("/api/admin")
@RequiredArgsConstructor
public class AdminHospitalController {

    private final AdminHospitalService hospitalService;

    @GetMapping("/hospitals")
    public ApiResult<PageResult<AdminHospitalView>> page(
            @RequestParam(required = false) String keyword,
            @RequestParam(defaultValue = "1") long page,
            @RequestParam(defaultValue = "20") long size) {
        return ApiResult.ok(hospitalService.page(keyword, page, size));
    }

    @PostMapping("/hospitals")
    public ApiResult<Void> create(@Valid @RequestBody AdminHospitalRequest req) {
        hospitalService.create(req);
        return ApiResult.ok();
    }

    @PutMapping("/hospitals/{code}")
    public ApiResult<Void> update(@PathVariable String code,
                                  @Valid @RequestBody AdminHospitalRequest req) {
        hospitalService.update(code, req);
        return ApiResult.ok();
    }

    /** 删除院区会连带逻辑删除其院内地点，避免留下孤儿导航数据 */
    @DeleteMapping("/hospitals/{code}")
    public ApiResult<Void> delete(@PathVariable String code) {
        hospitalService.delete(code);
        return ApiResult.ok();
    }

    @GetMapping("/hospitals/{code}/places")
    public ApiResult<List<AdminPlaceView>> places(@PathVariable String code) {
        return ApiResult.ok(hospitalService.listPlaces(code));
    }

    @PostMapping("/hospitals/{code}/places")
    public ApiResult<Map<String, Object>> addPlace(@PathVariable String code,
                                                   @Valid @RequestBody AdminPlaceRequest req) {
        Long id = hospitalService.addPlace(code, req);
        return ApiResult.ok(Map.of("id", id));
    }

    @DeleteMapping("/places/{id}")
    public ApiResult<Void> deletePlace(@PathVariable long id) {
        hospitalService.deletePlace(id);
        return ApiResult.ok();
    }
}
