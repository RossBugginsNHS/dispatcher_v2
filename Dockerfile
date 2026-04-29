FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM public.ecr.aws/lambda/nodejs:22@sha256:68eea3ead8b4675c0dace6dd8e22a799758b93f69a5b0dae61f043be620c7d6d AS runtime
WORKDIR /var/task
ENV NODE_ENV=production
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Terraform sets per-function commands via image_config.command.
# This default is only used if no override is supplied.
CMD ["dist/lambda/ingress-handler.handler"]
