FROM node:22-bookworm-slim

# Install Java (JDK 17)
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm i --omit=dev

COPY . .

ENV PORT=5000
EXPOSE 5000

CMD ["node", "index.js"]
