# Self-Hosted Deployment on Cloudflare Workers

This fork adds **Cloudflare Workers** support to [github-profile-trophy](https://github.com/ryo-ma/github-profile-trophy) by [@ryo-ma](https://github.com/ryo-ma).

## Why this fork?

The original project generates beautiful GitHub profile trophy cards and is used by thousands of developers. The public Vercel/Deno Deploy instance can experience downtime and rate limiting.

This fork includes a **standalone Cloudflare Workers implementation** (pure JavaScript, no Deno dependencies) that faithfully reproduces the original trophy rendering with:
- **100,000 free requests/day** on Cloudflare's edge network
- **Zero cold starts** and global edge delivery
- **15 trophy types** (7 standard + 8 secret) with animated progress bars
- **8 themes**: default, dracula, flat, onedark, nord, radical, tokyonight, darkhub

All credit goes to **[@ryo-ma](https://github.com/ryo-ma)** and the [contributors](https://github.com/ryo-ma/github-profile-trophy/graphs/contributors) for creating this wonderful project.

## Deploy Your Own

```bash
# 1. Fork this repo
# 2. Clone
git clone https://github.com/YOUR_USERNAME/github-profile-trophy.git
cd github-profile-trophy

# 3. Set your GitHub token
npx wrangler secret put GITHUB_TOKEN
# Paste a GitHub PAT with read:user scope

# 4. Deploy
npx wrangler deploy
```

Live at: `https://github-profile-trophy.YOUR_SUBDOMAIN.workers.dev`

## What was built

The `worker/index.js` is a standalone implementation that ports the original Deno source logic to pure JavaScript for Cloudflare Workers compatibility. It includes the complete GitHub GraphQL query, all 15 trophy types with rank thresholds, SVG rendering with gradient animations, and 8 color themes.

The original Deno/Vercel deployment is preserved — no source files were modified.
