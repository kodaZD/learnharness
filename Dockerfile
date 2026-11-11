FROM node:26-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run plugins:setup
RUN npm run build
RUN node scripts/build-server.mjs

FROM node:26-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    LH_DATA_DIR=/var/lib/learnharness/data \
    LH_AUTH_FILE=/var/lib/learnharness/auth.json

WORKDIR /app

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

RUN mkdir -p /var/lib/learnharness/data \
    && printf '{}\n' > /var/lib/learnharness/auth.json \
    && chown -R node:node /app /var/lib/learnharness

USER node

EXPOSE 3000

CMD ["node", "server.js"]
