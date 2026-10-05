import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_LAMA_MODEL_URL: process.env.NEXT_PUBLIC_LAMA_MODEL_URL ?? "",
  },
};

export default nextConfig;
