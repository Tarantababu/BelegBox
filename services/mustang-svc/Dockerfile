# The KoSIT validator.
#
# Paths are relative to the repository root, because that is the build context
# Fly uses for every app here. One context for all three images beats a special
# case that only shows up as a confusing "not found" during a deploy.

FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY services/mustang-svc/pom.xml services/mustang-svc/versions.properties ./
COPY services/mustang-svc/src ./src
RUN mvn -q -B package -DskipTests

# The validator configuration, fetched and digest-checked at build time.
#
# It is not in the repository - it is a 40 MB third-party release - and it is
# also not optional: without it the service starts, answers /health with "ok",
# and returns a form verdict of "unknown" for every document ever sent to it.
# That is the failure this stage exists to prevent, because nothing downstream
# can tell it apart from a validator that simply had nothing to say.
#
# The fetch script owns the pinned tag and digest, so there is one place to
# change and the corpus snapshots show what moved (R-2).
FROM debian:bookworm-slim AS config
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip bash \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /svc
COPY services/mustang-svc/scripts/fetch-validator-config.sh scripts/
RUN bash scripts/fetch-validator-config.sh \
 && test -f validator-config/scenarios.xml

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
RUN addgroup -S svc && adduser -S svc -G svc

COPY --from=build  /build/target/mustang-svc.jar ./mustang-svc.jar
COPY --from=config /svc/validator-config ./validator-config

USER svc
EXPOSE 8081
ENV PORT=8081 VALIDATOR_CONFIG_DIR=/app/validator-config

# Refuses to come up healthy without the scenarios, so a misbuilt image fails
# where it is visible rather than by quietly validating nothing.
HEALTHCHECK --interval=10s --timeout=3s --start-period=25s \
  CMD wget -qO- http://127.0.0.1:8081/health | grep -q '"status":"ok"' || exit 1

ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/mustang-svc.jar"]
