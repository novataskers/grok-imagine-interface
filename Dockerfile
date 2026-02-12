FROM node:20-slim

# Install Chrome dependencies + xvfb for virtual display
RUN apt-get update && apt-get install -y \
    chromium \
    xvfb \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-khmeros fonts-kacst fonts-freefont-ttf \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json bun.lockb* package-lock.json* ./
RUN npm install --production

COPY server.js ./

ENV CHROME_PROFILE_DIR=/data/chrome-profile
ENV XVFB=1

ENV PORT=4000
EXPOSE 4000

CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x900x24", "node", "server.js"]
