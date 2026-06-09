FROM node:22-slim

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    chromium \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
