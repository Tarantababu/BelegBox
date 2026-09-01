/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The web app is a client of /v1 like any other. It holds no database
  // credentials and reaches no table directly (PRD § 4).
  env: { API_URL: process.env.API_URL ?? "http://localhost:8082" },
};
