FROM node:22-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    libgobject-2.0-0 libglib2.0-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libdbus-1-3 libxcb1 libxkbcommon0 libx11-6 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libasound2 fonts-liberation \
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
