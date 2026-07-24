FROM node:20-slim

# Install system dependencies required by sharp
RUN apt-get update && apt-get install -y \
    libvips-dev \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --no-audit --no-fund --legacy-peer-deps

COPY . .

EXPOSE 5000

CMD [ "npm", "start" ]
