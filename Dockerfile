# --- build the frontend ---
FROM node:22-alpine AS web
WORKDIR /build
COPY web/package.json ./package.json
RUN npm install
COPY web/ ./
RUN npm run build

# --- runtime ---
FROM node:22-alpine
WORKDIR /app
COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev
COPY server/ ./server/
COPY --from=web /build/dist ./web/dist
ENV PORT=8790
EXPOSE 8790
CMD ["node", "server/src/index.js"]
