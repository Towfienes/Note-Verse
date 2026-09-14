FROM node:20-alpine
WORKDIR /usr/src/app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p data uploads
EXPOSE 8080
CMD ["node", "server.js"]
