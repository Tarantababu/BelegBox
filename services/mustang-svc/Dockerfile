# Build
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY pom.xml versions.properties ./
COPY src ./src
RUN mvn -q -B package -DskipTests

# Run
FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
RUN addgroup -S svc && adduser -S svc -G svc
COPY --from=build /build/target/mustang-svc.jar ./mustang-svc.jar
# Vendored XSDs are mounted rather than baked, so pinning them is visible in
# the compose file instead of hidden in a layer.
VOLUME ["/app/schemas"]
USER svc
EXPOSE 8081
ENV PORT=8081 SCHEMA_DIR=/app/schemas
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s \
  CMD wget -qO- http://localhost:8081/health || exit 1
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/mustang-svc.jar"]
