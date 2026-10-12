FROM node:20-bookworm-slim

# git y rsync son las dos herramientas externas que usa el servicio.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git rsync ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY LICENSE README.md ./

# /data: base de datos y carpeta de trabajo temporal.
# /copias: donde montar la carpeta de destino de las copias (se indica luego en Ajustes).
ENV NODE_ENV=production \
    RESGUARD_PUERTO=3200 \
    RESGUARD_DATOS=/data
RUN mkdir -p /data /copias
VOLUME ["/data"]
EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.RESGUARD_PUERTO + '/api/resumen').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/server.js"]
