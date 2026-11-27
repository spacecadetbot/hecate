FROM node:22-slim
# ffmpeg: thumbnails, audio conversion, video frames. poppler-utils: PDF text. unzip: Word/PowerPoint/Excel text.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg poppler-utils unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /data && chown node:node /data
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV HECATE_DATA_DIR=/data HECATE_HOST=0.0.0.0 HECATE_PORT=8080
VOLUME /data
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
