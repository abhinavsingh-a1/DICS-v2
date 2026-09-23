# Unlike every other Dockerfile in this project, this one does NOT run
# a persistent service — safe-ops is a set of one-off administrative
# scripts (deploy infrastructure once, create a Safe once, propose a
# transaction on demand, add/remove an owner on demand). This image is
# meant to be run with `docker run ... node scripts/<name>.js <args>`,
# not left running — see docker-compose.yml's own comment on why this
# service uses `profiles` rather than starting automatically with
# `docker compose up`.

FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENTRYPOINT ["node"]
CMD ["scripts/04-propose-and-execute-transaction.js"]
