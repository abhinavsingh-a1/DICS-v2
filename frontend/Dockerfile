# Dev-mode only — runs the Vite dev server, matching this project's
# current local-development focus (see besu-network/README.md's "local
# first" approach). A production build+serve Dockerfile (multi-stage,
# `vite build` + nginx or similar) is a reasonable next step but isn't
# what's needed for "get everything running locally with docker-compose."
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
