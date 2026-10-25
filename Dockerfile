FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY public ./public
ENV PORT=4100 SIMULATE=true
EXPOSE 4100
CMD ["node", "server.js"]
