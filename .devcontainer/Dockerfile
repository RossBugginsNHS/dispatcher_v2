# syntax=docker/dockerfile:1

# SHA-pinned base: mcr.microsoft.com/devcontainers/javascript-node:22
FROM mcr.microsoft.com/devcontainers/javascript-node:24@sha256:e66ed141c99e4190bf9dbf56db59f46f98cf172a341dfdd601ae6a78b23abbb3

USER root

# ── Terraform ───────────────────────────────────────────────────────────────
# Versions and SHA256 digests are sourced from mise.lock (linux-amd64 / linux-arm64).
# Update both the version and the matching SHA values when bumping.
ARG TERRAFORM_VERSION=1.13.4
ARG TERRAFORM_SHA256_AMD64=98aa516201e948306698efd9954ab4cc0d1227c2578ba56245898b5f679e590b
ARG TERRAFORM_SHA256_ARM64=a17bde150a4d6c9e7ece063ab634c07723b8242e078f3ae9017486277d6690c4

RUN DPKG_ARCH="$(dpkg --print-architecture)" && \
    case "${DPKG_ARCH}" in \
      amd64)  TF_SHA="${TERRAFORM_SHA256_AMD64}"; TF_ARCH="amd64" ;; \
      arm64)  TF_SHA="${TERRAFORM_SHA256_ARM64}"; TF_ARCH="arm64" ;; \
      *)      echo "Unsupported arch: ${DPKG_ARCH}" && exit 1 ;; \
    esac && \
    curl -fsSL \
      "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${TF_ARCH}.zip" \
      -o /tmp/terraform.zip && \
    echo "${TF_SHA}  /tmp/terraform.zip" | sha256sum -c && \
    unzip /tmp/terraform.zip -d /usr/local/bin && \
    rm /tmp/terraform.zip && \
    terraform version

# ── AWS CLI v2 ───────────────────────────────────────────────────────────────
# Uses the official bundled installer which includes its own signature verification.
RUN MACHINE="$(uname -m)" && \
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${MACHINE}.zip" \
      -o /tmp/awscliv2.zip && \
    unzip /tmp/awscliv2.zip -d /tmp && \
    /tmp/aws/install && \
    rm -rf /tmp/aws /tmp/awscliv2.zip && \
    aws --version

# ── mise ─────────────────────────────────────────────────────────────────────
# Pinned to a specific release. Update MISE_VERSION when bumping.
# The mise binary naming convention uses "x64" for amd64 and "arm64" for arm64.
ARG MISE_VERSION=2025.4.6

RUN MACHINE="$(uname -m)" && \
    case "${MACHINE}" in \
      x86_64)  MISE_ARCH=x64   ;; \
      aarch64) MISE_ARCH=arm64 ;; \
      *)       echo "Unsupported arch: ${MACHINE}" && exit 1 ;; \
    esac && \
    curl -fsSL \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${MISE_ARCH}" \
      -o /usr/local/bin/mise && \
    chmod +x /usr/local/bin/mise && \
    mise --version

USER node
