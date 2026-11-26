import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.0.140"],
  output: "standalone",
  // The Dautel theme is fixed when the image is built (dautel, mocha, macchiato, frappe or latte).
  env: { OPSBRAIN_UI_THEME: process.env.OPSBRAIN_UI_THEME || "dautel" },
};

export default nextConfig;
