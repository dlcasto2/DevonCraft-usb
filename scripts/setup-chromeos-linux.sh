#!/usr/bin/env bash
set -euo pipefail

sudo apt update
sudo apt install -y libusb-1.0-0 libusb-1.0-0-dev build-essential pkg-config
npm install --omit=dev
printf '\nRuntime dependencies installed. Configure your local MCP host to run:\n  node server/index.mjs\n'
