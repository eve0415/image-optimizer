FROM node:lts-alpine AS builder-base
RUN --mount=type=cache,target=/var/cache/apt \
    apk add python3 make g++
WORKDIR /app
COPY --link .yarn/ ./.yarn
COPY --link .yarnrc.yml package.json yarn.lock ./


FROM builder-base AS builder
WORKDIR /app
RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    --mount=type=cache,target=/root/.cache \
    yarn install --immutable --inline-builds --network-timeout 100000
COPY --link . .
RUN chmod +x build.js
RUN yarn build


FROM builder-base AS production
RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    --mount=type=cache,target=/root/.cache \
    yarn workspaces focus --production
COPY --from=builder /app/out ./


FROM gcr.io/distroless/nodejs18-debian11:nonroot AS runner
WORKDIR /app
ENV NODE_ENV production
EXPOSE 8080
COPY --from=production /app ./
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 CMD [ "curl", "-f", "http://localhost:8080/live ]
CMD ["yarn", "node", "--enable-source-maps", "index.js"]
