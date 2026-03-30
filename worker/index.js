/**
 * Cloudflare Workers entry point for github-profile-trophy.
 * Standalone implementation — no Deno dependencies.
 * Fetches GitHub user data via GraphQL, calculates trophy ranks, renders SVG grid.
 */

const GRAPHQL_QUERY = `query($login: String!) {
  user(login: $login) {
    name login avatarUrl createdAt
    followers { totalCount }
    repositories(first: 100, ownerAffiliations: OWNER, orderBy: {direction: DESC, field: STARGAZERS}) {
      totalCount
      nodes { stargazerCount languages(first: 3) { nodes { name } } }
    }
    pullRequests { totalCount }
    issues { totalCount }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestReviewContributions
    }
  }
}`;

// --- Rank system ---
const RANKS = ["C", "B", "A", "AA", "AAA", "S", "SS", "SSS"];
const RANK_COLORS = {
  SSS: "#ff0", SS: "#ff0", S: "#ff8c00",
  AAA: "#ff6347", AA: "#db7093", A: "#da70d6",
  B: "#1e90ff", C: "#90ee90", SECRET: "#c0c0c0", UNKNOWN: "#666",
};

function getRank(value, thresholds) {
  // thresholds: [C, B, A, AA, AAA, S, SS, SSS]
  for (let i = thresholds.length - 1; i >= 0; i--) {
    if (value >= thresholds[i]) return RANKS[i];
  }
  return "UNKNOWN";
}

// --- Trophy definitions ---
function calculateTrophies(user) {
  const stars = user.repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0);
  const commits = user.contributionsCollection.totalCommitContributions;
  const followers = user.followers.totalCount;
  const issues = user.issues.totalCount;
  const prs = user.pullRequests.totalCount;
  const repos = user.repositories.totalCount;
  const langs = new Set(user.repositories.nodes.flatMap(r => r.languages.nodes.map(l => l.name))).size;
  const years = Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (365.25 * 86400000));
  const superRepo = user.repositories.nodes.some(r => r.stargazerCount >= 1000);

  const trophies = [
    { title: "Stars", value: stars, rank: getRank(stars, [1, 10, 50, 200, 500, 1000, 5000, 10000]) },
    { title: "Commits", value: commits, rank: getRank(commits, [1, 50, 200, 500, 1000, 2000, 5000, 10000]) },
    { title: "Followers", value: followers, rank: getRank(followers, [1, 10, 50, 100, 500, 1000, 5000, 10000]) },
    { title: "Issues", value: issues, rank: getRank(issues, [1, 5, 20, 50, 100, 500, 1000, 5000]) },
    { title: "PRs", value: prs, rank: getRank(prs, [1, 5, 20, 50, 100, 500, 1000, 5000]) },
    { title: "Repositories", value: repos, rank: getRank(repos, [1, 5, 20, 50, 100, 200, 500, 1000]) },
    { title: "Languages", value: langs, rank: getRank(langs, [1, 3, 5, 8, 12, 16, 20, 25]) },
    { title: "Experience", value: years, rank: getRank(years, [1, 2, 3, 5, 7, 10, 15, 20]) },
  ];

  // Secret trophies
  if (superRepo) trophies.push({ title: "SuperRepo", value: "★", rank: "SECRET" });
  if (stars >= 1) trophies.push({ title: "FirstStar", value: "1st", rank: "SECRET" });

  return trophies.filter(t => t.rank !== "UNKNOWN");
}

// --- SVG rendering ---
const PANEL_W = 110;
const PANEL_H = 128;

function renderTrophy(trophy, theme) {
  const color = RANK_COLORS[trophy.rank] || "#666";
  const bg = theme.bg || "transparent";
  const border = theme.frame ? `<rect x="0.5" y="0.5" width="${PANEL_W - 1}" height="${PANEL_H - 1}" rx="4" fill="${bg}" stroke="${theme.border || '#e1e4e8'}"/>` : "";

  return `<g>
    ${border}
    <text x="${PANEL_W / 2}" y="22" text-anchor="middle" font-size="10" font-weight="bold" fill="${color}">${trophy.rank}</text>
    <text x="${PANEL_W / 2}" y="58" text-anchor="middle" font-size="36" fill="${color}">🏆</text>
    <text x="${PANEL_W / 2}" y="82" text-anchor="middle" font-size="10" font-weight="bold" fill="${theme.title || '#434d58'}">${trophy.title}</text>
    <text x="${PANEL_W / 2}" y="98" text-anchor="middle" font-size="9" fill="${theme.text || '#666'}">${trophy.value}</text>
  </g>`;
}

function renderCard(trophies, columns, rows, theme, marginW, marginH) {
  const maxTrophies = columns * rows;
  const visible = trophies.slice(0, maxTrophies);
  const actualRows = Math.ceil(visible.length / columns);
  const w = columns * (PANEL_W + marginW);
  const h = actualRows * (PANEL_H + marginH);

  const panels = visible.map((t, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = col * (PANEL_W + marginW);
    const y = row * (PANEL_H + marginH);
    return `<g transform="translate(${x},${y})">${renderTrophy(t, theme)}</g>`;
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <style>text { font-family: 'Segoe UI', Ubuntu, sans-serif; }</style>
  ${panels}
</svg>`;
}

// --- Themes ---
const THEMES = {
  default: { bg: "#fff", border: "#e1e4e8", title: "#434d58", text: "#666", frame: true },
  flat: { bg: "#fff", border: "#e1e4e8", title: "#434d58", text: "#666", frame: false },
  onedark: { bg: "#282c34", border: "#4b5263", title: "#e5c07b", text: "#abb2bf", frame: true },
  gruvbox: { bg: "#282828", border: "#3c3836", title: "#fabd2f", text: "#ebdbb2", frame: true },
  dracula: { bg: "#282a36", border: "#44475a", title: "#f1fa8c", text: "#f8f8f2", frame: true },
  monokai: { bg: "#272822", border: "#3e3d32", title: "#e6db74", text: "#f8f8f2", frame: true },
  chalk: { bg: "#313131", border: "#4b4b4b", title: "#e0e0e0", text: "#aaaaaa", frame: true },
  nord: { bg: "#2e3440", border: "#4c566a", title: "#88c0d0", text: "#d8dee9", frame: true },
  alduin: { bg: "#1c1c1c", border: "#3a3a3a", title: "#c9a554", text: "#e0d7c3", frame: true },
  darkhub: { bg: "#0d1117", border: "#30363d", title: "#58a6ff", text: "#c9d1d9", frame: true },
  juicyfresh: { bg: "#fff", border: "#a7d676", title: "#26890c", text: "#1a7431", frame: true },
  buddhism: { bg: "#fdf6ec", border: "#d4a843", title: "#c5842c", text: "#6b4e20", frame: true },
  oldie: { bg: "#f5deb3", border: "#c0a870", title: "#8b4513", text: "#654321", frame: true },
  radical: { bg: "#141321", border: "#fe428e", title: "#fe428e", text: "#a9fef7", frame: true },
  onestar: { bg: "#011627", border: "#1e3a5f", title: "#8be9fd", text: "#d6deeb", frame: true },
  discord: { bg: "#36393f", border: "#40444b", title: "#7289da", text: "#dcddde", frame: true },
  algolia: { bg: "#050f2c", border: "#2b3595", title: "#5468ff", text: "#b3bfda", frame: true },
  gitdimmed: { bg: "#22272e", border: "#373e47", title: "#539bf5", text: "#adbac7", frame: true },
  tokyonight: { bg: "#1a1b26", border: "#414868", title: "#7aa2f7", text: "#a9b1d6", frame: true },
  matrix: { bg: "#0d0208", border: "#003b00", title: "#00ff41", text: "#008f11", frame: true },
  apprentice: { bg: "#262626", border: "#444444", title: "#87af87", text: "#bcbcbc", frame: true },
  dark_dimmed: { bg: "#22272e", border: "#444c56", title: "#539bf5", text: "#768390", frame: true },
  dark_lover: { bg: "#1e1e2e", border: "#45475a", title: "#cba6f7", text: "#bac2de", frame: true },
  kimbie_dark: { bg: "#221a0f", border: "#5e452b", title: "#d3af86", text: "#a57a4c", frame: true },
};

// --- Main handler ---
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const username = url.searchParams.get("username");

    if (!username) {
      return new Response(
        '<html><body><h1>GitHub Profile Trophy</h1><p>Usage: ?username=YOUR_USERNAME</p></body></html>',
        { headers: { "Content-Type": "text/html" } }
      );
    }

    const token = env.GITHUB_TOKEN || env.PAT_1;
    if (!token) {
      return new Response("GITHUB_TOKEN not configured", { status: 500 });
    }

    const columns = parseInt(url.searchParams.get("column") || "6", 10);
    const rows = parseInt(url.searchParams.get("row") || "3", 10);
    const themeName = url.searchParams.get("theme") || "default";
    const marginW = parseInt(url.searchParams.get("margin-w") || "0", 10);
    const marginH = parseInt(url.searchParams.get("margin-h") || "0", 10);
    const noFrame = url.searchParams.get("no-frame") === "true";
    const titleFilter = (url.searchParams.get("title") || "").split(",").filter(Boolean);
    const rankFilter = (url.searchParams.get("rank") || "").split(",").filter(Boolean).map(r => r.toUpperCase());

    const theme = { ...(THEMES[themeName] || THEMES.default) };
    if (noFrame) theme.frame = false;
    if (url.searchParams.get("no-bg") === "true") theme.bg = "transparent";

    try {
      const resp = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `bearer ${token}`,
          "User-Agent": "github-profile-trophy-cf-worker",
        },
        body: JSON.stringify({ query: GRAPHQL_QUERY, variables: { login: username } }),
      });

      const json = await resp.json();
      if (json.errors || !json.data?.user) {
        return new Response(
          `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="50"><text x="10" y="30" font-size="14" fill="red">User not found: ${username}</text></svg>`,
          { headers: { "Content-Type": "image/svg+xml" } }
        );
      }

      let trophies = calculateTrophies(json.data.user);

      if (titleFilter.length > 0) {
        trophies = trophies.filter(t => titleFilter.some(f => t.title.toLowerCase().includes(f.toLowerCase())));
      }
      if (rankFilter.length > 0) {
        trophies = trophies.filter(t => rankFilter.includes(t.rank));
      }

      // Sort: higher ranks first
      const rankOrder = [...RANKS, "SECRET"].reverse();
      trophies.sort((a, b) => rankOrder.indexOf(a.rank) - rankOrder.indexOf(b.rank));

      const svg = renderCard(trophies, columns, rows, theme, marginW, marginH);

      return new Response(svg, {
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, s-maxage=28800, stale-while-revalidate=86400",
        },
      });
    } catch (err) {
      return new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="50"><text x="10" y="30" font-size="14" fill="red">${err.message}</text></svg>`,
        { headers: { "Content-Type": "image/svg+xml" } }
      );
    }
  },
};
