FROM node:26-alpine@sha256:e71ac5e964b9201072425d59d2e876359efa25dc96bb1768cb73295728d6e4ea AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26-alpine@sha256:e71ac5e964b9201072425d59d2e876359efa25dc96bb1768cb73295728d6e4ea AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM public.ecr.aws/lambda/nodejs:22@sha256:52a37f71e957669f2cbdc10de0bed24be30b4a84821d36ed8a1e57b037a4cb1a AS runtime
WORKDIR /var/task
ENV NODE_ENV=production
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Terraform sets per-function commands via image_config.command.
# This default is only used if no override is supplied.
CMD ["dist/lambda/ingress-handler.handler"]
