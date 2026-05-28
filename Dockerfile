FROM node:20-alpine
WORKDIR /app
COPY server.js .
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node","server.js"]
