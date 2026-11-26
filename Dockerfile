# Wedge — single container, no build step, no dependencies.
FROM node:20-alpine

WORKDIR /app
COPY . .

# Data lives outside the image so a redeploy does not wipe accounts.
ENV NODE_ENV=production
ENV DATA_FILE=/data/db.json
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8787
CMD ["node", "server/server.js"]
