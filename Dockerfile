FROM node:24-alpine

RUN apk add --no-cache curl jq tree

WORKDIR /

COPY scripts/ /usr/local/bin/

RUN npm install -g /usr/local/bin/utils

RUN chmod 777 /usr/local/bin/get_modules; \
    chmod 777 /usr/local/bin/importmap_generator
