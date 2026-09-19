FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV DATA_DIR=/data
ENV PORT=8080
ENV POLL_MS=3000

VOLUME ["/data"]
EXPOSE 8080

CMD ["npm", "start"]
