# ==================================================================
#  后端镜像（仅 Spring Boot）
#
#  为什么要和前端拆成两个镜像：
#    免费托管档的单个服务内存上限是 512 MB，JVM 与 Node 挤在一起必定 OOM。
#    拆开之后后端独占 512 MB，前端也独占 512 MB，各自有余量。
#    这本来就是 docs/14 里的生产拓扑（systemd 管两个单元），
#    一体化镜像（仓库根的 Dockerfile）只是单容器平台的权宜之计。
#
#  构建：docker build -f backend/Dockerfile -t zhidao-backend backend/
#  运行：docker run -p 8080:8080 zhidao-backend
# ==================================================================

# ------------------------------------------------------------------
# 阶段一：构建
# ------------------------------------------------------------------
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /src

# 先只拷 pom：依赖层可缓存，改代码不必重下依赖
COPY pom.xml ./
RUN mvn -B -ntp -q dependency:go-offline || true

COPY src ./src
# 跳过测试：CI 与本地已经跑过，镜像构建只负责产出可运行的 jar
RUN mvn -B -ntp -q clean package -DskipTests

# ------------------------------------------------------------------
# 阶段二：运行时。JRE 而非 JDK，省约 200 MB
# ------------------------------------------------------------------
FROM eclipse-temurin:17-jre

WORKDIR /app
COPY --from=build /src/target/zhidao-backend-0.1.0.jar ./app.jar

# 堆与元空间刻意压小：512 MB 的容器里，JVM 的常驻 = 堆 + 元空间
# + 线程栈 + code cache + GC 结构，默认值（堆取物理内存的 1/4）会直接吃满。
# 192m 堆对"几张表 + 种子数据"的规模足够；SerialGC 在单核小堆下开销最低。
ENV JAVA_OPTS="-Xms96m -Xmx192m -XX:MaxMetaspaceSize=96m -XX:+UseSerialGC"

EXPOSE 8080

# exec 让 JVM 接管 PID 1，SIGTERM 才能优雅停机（否则平台重启要等超时强杀）
CMD ["sh", "-c", "exec java $JAVA_OPTS -Dfile.encoding=UTF-8 -jar app.jar --server.port=8080 --server.address=0.0.0.0"]
