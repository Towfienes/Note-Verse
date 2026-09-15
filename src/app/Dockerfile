FROM node:20.20.2-alpine

WORKDIR /usr/src/app
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && mkdir -p data uploads \
  && chown -R node:node /usr/src/app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && apk del .build-deps

COPY --chown=node:node . .
USER node

EXPOSE 8080
CMD ["node", "server.js"]
