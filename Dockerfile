FROM node:22-alpine
WORKDIR /app
COPY package.json server.js lib/ public/ ./
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
