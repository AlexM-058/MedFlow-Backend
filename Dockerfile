# Imaginea Docker a Backend-ului MedFlow (de exemplu pentru Azure Container Apps).
#
# Construire (din folderul MedFlow-Backend):
#   docker build -t medflow-backend .
# Rulare locală (cheile vin din .env; fișierul .env NU intră în imagine):
#   docker run --rm --env-file .env -e HOST=0.0.0.0 -p 3001:3001 medflow-backend
#
# node:22-slim (Debian) și nu node:22-alpine: TypeScript 7 are program nativ pentru
# Linux obișnuit (glibc), dar nu are o variantă separată pentru Alpine (musl).

# --- Etapa 1: compilăm TypeScript -> JavaScript (dist/) ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Etapa 2: imaginea finală, doar cu ce trebuie la rulare ---
# Fără TypeScript, fără tsx, fără sursele .ts: doar dist/ și dependențele de producție.
FROM node:22-slim
WORKDIR /app
# HOST=0.0.0.0: într-un container trebuie să ascultăm pe toate interfețele,
# altfel Azure (sau `docker run -p`) nu poate ajunge la server.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Rulăm ca utilizatorul obișnuit `node`, nu ca root.
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
