FROM node:18-alpine

WORKDIR /usr/src/app

# Install runtime dependencies
COPY package.json package-lock.json* ./
RUN npm install --production
RUN npm install cors

ENV TOKEN_SECRET="opentoken"
ENV API_KEY="openkey"
ENV GUAC_VERSION="1.6.0"

# Copy app source
COPY . .


RUN apk add --no-cache curl unzip

# download the WAR from the Apache mirrors
RUN curl -fsSL "https://downloads.apache.org/guacamole/${GUAC_VERSION}/binary/guacamole-${GUAC_VERSION}.war" \
      -o /tmp/guac.war

# extract guacamole-common-js bundles into /usr/share/nginx/html/js
RUN mkdir -p public/js && \
    unzip -j /tmp/guac.war \
      "guacamole-common-js/all.js" \
      "guacamole-common-js/all.min.js" \
      -d public/js && \
    rm /tmp/guac.war

EXPOSE 8080

CMD ["node", "index.js"]
