import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root. A stray package-lock.json in a parent directory
  // made Turbopack infer the wrong root, which can break a clean-clone build.
  // import.meta.dirname is this file's directory (the real project root).
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;
