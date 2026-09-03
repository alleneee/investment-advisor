FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/agent-runtime ./apps/agent-runtime

RUN npm install

ENV NODE_ENV=production
ENV PORT=8081

EXPOSE 8081

CMD ["node", "--import", "tsx", "apps/agent-runtime/src/server-entry.ts"]
