# Gestor IPTV — versão externa (fora do Muse)
# Imagem Bun + Node: o Bun roda o servidor e compila o cliente; o Node
# é necessário SOMENTE para o processo filho da sessão do WhatsApp
# (Baileys), herdado do gestor original. Se o Node não estiver
# instalado, a geração do QR Code falha com mensagem simples na tela —
# nenhum QR Code é inventado.
FROM oven/bun:1
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build:client

ENV NODE_ENV=production
# O Render define a porta na variável PORT em tempo de execução.
CMD ["bun", "server/src/server.ts"]
