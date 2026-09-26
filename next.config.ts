import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig = (phase: string): NextConfig => ({
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next" : ".next-build",
  serverExternalPackages: ["pg", "@electric-sql/pglite", "proper-lockfile"],
});

export default nextConfig;
