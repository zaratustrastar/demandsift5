import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // DigitalOcean runs the self-contained Node server emitted by vinext. That
  // keeps server-only APIs (including the DNS-pinned website crawler) on the
  // Node runtime instead of a Workers compatibility layer.
  output: "standalone",
};

export default nextConfig;
