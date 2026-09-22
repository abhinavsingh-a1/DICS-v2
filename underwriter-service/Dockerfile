# Multi-stage build, same principle as the Go service's Dockerfile: the
# full Maven + JDK build environment (large) never ships — only the
# resulting .jar plus a slim JRE (not a full JDK, since running a .jar
# needs no compiler) makes it into the final image.

FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml ./
RUN mvn dependency:go-offline
COPY src ./src
RUN mvn package -DskipTests

FROM eclipse-temurin:21-jre-jammy
COPY --from=build /src/target/underwriter-service-*.jar /app.jar
EXPOSE 8090
ENTRYPOINT ["java", "-jar", "/app.jar"]
