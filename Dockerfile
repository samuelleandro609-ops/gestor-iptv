# Gestor Flex — versão externa (fora do Muse)
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

# Navegador para a automação do botão "Renovar" (Sigma por login, só
# leitura na etapa atual): instala o Chromium headless + as bibliotecas
# de sistema. O cache fica dentro da imagem. Se esta etapa falhar, o
# build falha e o Render mantém a versão anterior no ar — o gestor
# avisa "navegador de automação não instalado" em vez de cair.
RUN bun x playwright install --with-deps chromium

COPY . .
RUN bun run build:client

ENV NODE_ENV=production
# O Render define a porta na variável PORT em tempo de execução.
CMD ["bun", "server/src/server.ts"]
