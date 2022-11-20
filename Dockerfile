FROM node:lts-alpine AS builder-base
RUN apk add python3 make g++
WORKDIR /app
COPY .yarn/ ./.yarn
COPY .yarnrc.yml package.json yarn.lock ./


FROM builder-base AS builder
WORKDIR /app
RUN yarn install --immutable --network-timeout 100000
COPY . .
RUN chmod +x build.js
RUN yarn build


FROM builder-base AS production
RUN yarn workspaces focus --production
COPY --from=builder /app/out ./


FROM node:lts-alpine AS runner
WORKDIR /app
ENV NODE_ENV production
EXPOSE 8080
COPY --from=production /app ./
CMD ["yarn", "node", "--enable-source-maps", "index.js"]
