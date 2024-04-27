FROM node:10-alpine as default

MAINTAINER Cristian Greco

EXPOSE 8080

RUN apk add --no-cache dumb-init

RUN --mount=type=cache,id=npm,target=/root/.npm npm init -y \
    && npm install express@4.16.4

COPY index.js .

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "index.js"]
