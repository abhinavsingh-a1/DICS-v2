# Same multi-stage principle as the Go and Java Dockerfiles: build with
# the full SDK (compiler included), ship only the compiled output plus
# the much smaller ASP.NET runtime image.

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY DocumentService.csproj ./
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app .
# Where LocalFileStorage writes uploaded files and the SQLite database —
# mounted as a named volume in docker-compose.yml so uploads survive a
# container restart (see that file's comment on this exact volume).
VOLUME /data
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
ENTRYPOINT ["dotnet", "DocumentService.dll"]
