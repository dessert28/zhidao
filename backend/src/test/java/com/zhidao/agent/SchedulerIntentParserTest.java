package com.zhidao.agent;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class SchedulerIntentParserTest {

    private SchedulerIntentParser parser;
    private static final LocalDate FIXED = LocalDate.of(2026, 11, 23); // 周一

    @BeforeEach
    void setUp() {
        parser = new SchedulerIntentParser();
    }

    @Test
    @DisplayName("科室识别：显式名 + 别名，对齐 TS 版")
    void departmentRecognition() {
        assertEquals("内分泌科", parser.parseBookingIntent("我想挂内分泌科").department());
        assertEquals("心血管内科", parser.parseBookingIntent("挂心内科").department());
        assertEquals("呼吸内科", parser.parseBookingIntent("约呼吸内科的号").department());
        assertNull(parser.parseBookingIntent("我想看看"), "抽不到科室返回 null，不瞎猜");
    }

    @Test
    @DisplayName("院区识别：第二医院 → Z2-JFL")
    void hospitalRecognition() {
        SchedulerIntentParser.BookingIntent i = parser.parseBookingIntent("第二医院骨科");
        assertEquals("骨科", i.department());
        assertEquals("Z2-JFL", i.hospitalCode());
    }

    @Test
    @DisplayName("日期解析：明天/后天/下周三 对齐 TS 版")
    void dateParsing() {
        assertEquals("2026-11-24", parser.parseDate("明天", FIXED));
        assertEquals("2026-11-25", parser.parseDate("后天", FIXED));
        assertEquals("2026-12-02", parser.parseDate("下周三", FIXED));
        assertNull(parser.parseDate("改天吧", FIXED));
    }

    @Test
    @DisplayName("意图含日期：明天去消化内科")
    void intentWithDate() {
        SchedulerIntentParser.BookingIntent i = parser.parseBookingIntent("明天去消化内科");
        assertEquals("消化内科", i.department());
        assertEquals("2026-11-24", i.date());
    }

    @Test
    @DisplayName("时间轴：内分泌科需空腹抽血，逐条对齐 TS 版")
    void timelineWithFasting() {
        List<SchedulerIntentParser.TimelineTask> tasks = parser.buildTimeline("内分泌科", "2026-11-24 09:00");
        assertEquals(4, tasks.size());
        assertEquals("空腹抽血（先做，避免进食影响结果）", tasks.get(0).task());
        assertTrue(tasks.get(0).dependsOn().isEmpty());
        assertEquals("到科室分诊台报到", tasks.get(1).task());
        assertEquals("预约时间 09:00，建议提前 20 分钟到", tasks.get(1).note());
        assertEquals("见内分泌科医生", tasks.get(2).task());
        assertEquals(List.of("空腹抽血"), tasks.get(2).dependsOn());
        assertEquals(List.of("见内分泌科医生"), tasks.get(3).dependsOn());
    }

    @Test
    @DisplayName("时间轴：非空腹科室无抽血步骤")
    void timelineNoFasting() {
        List<SchedulerIntentParser.TimelineTask> tasks = parser.buildTimeline("骨科", "");
        assertEquals(3, tasks.size());
        assertEquals("到科室分诊台报到", tasks.get(0).task());
        assertEquals("", tasks.get(0).note());
        assertTrue(tasks.get(1).dependsOn().isEmpty());
    }
}
