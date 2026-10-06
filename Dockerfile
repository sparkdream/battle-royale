# Build: install everything, build the client, then drop dev dependencies.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Run: one process serves the game server and the built client on $PORT.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=2567
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/shared shared
COPY --from=build /app/server server
COPY --from=build /app/client/package.json client/
COPY --from=build /app/client/dist client/dist
USER node
EXPOSE 2567
CMD ["npm", "start"]
