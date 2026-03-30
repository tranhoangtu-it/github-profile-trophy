/**
 * Cloudflare Worker — GitHub Profile Trophy Generator
 *
 * Single-file worker. No Deno APIs, no external deps.
 * Uses native fetch() and standard Web APIs only.
 *
 * Required secret:  GITHUB_TOKEN  (wrangler secret put GITHUB_TOKEN)
 * Optional:         GITHUB_TOKEN2, GITHUB_API
 *
 * Query params: username, theme, row, column, title, rank,
 *               no-bg, no-frame, margin-w, margin-h
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CDN_CACHE_MAX_AGE = 28800;       // 8 h
const STALE_WHILE_REVALIDATE = 86400;  // 24 h
const GITHUB_API_URL = "https://api.github.com/graphql";

const DEFAULT_MAX_COLUMN = 6;
const DEFAULT_MAX_ROW = 3;
const DEFAULT_MARGIN_W = 0;
const DEFAULT_MARGIN_H = 0;
const DEFAULT_NO_BACKGROUND = false;
const DEFAULT_NO_FRAME = false;
const DEFAULT_PANEL_SIZE = 110;

// ---------------------------------------------------------------------------
// Rank system
// ---------------------------------------------------------------------------

const RANK = Object.freeze({
  SECRET: "SECRET",
  SSS: "SSS",
  SS: "SS",
  S: "S",
  AAA: "AAA",
  AA: "AA",
  A: "A",
  B: "B",
  C: "C",
  UNKNOWN: "?",
});

/** Highest rank first, UNKNOWN last */
const RANK_ORDER = [
  RANK.SECRET,
  RANK.SSS,
  RANK.SS,
  RANK.S,
  RANK.AAA,
  RANK.AA,
  RANK.A,
  RANK.B,
  RANK.C,
  RANK.UNKNOWN,
];

// ---------------------------------------------------------------------------
// GitHub GraphQL query — combined single round-trip
// ---------------------------------------------------------------------------

const QUERY_USER_ALL = `
  query userInfo($username: String!) {
    user(login: $username) {
      createdAt
      contributionsCollection {
        totalCommitContributions
        restrictedContributionsCount
        totalPullRequestReviewContributions
      }
      organizations(first: 1) { totalCount }
      followers(first: 1)     { totalCount }
      openIssues:  issues(states: OPEN)   { totalCount }
      closedIssues: issues(states: CLOSED) { totalCount }
      pullRequests(first: 1) { totalCount }
      repositories(
        first: 50,
        ownerAffiliations: OWNER,
        orderBy: { direction: DESC, field: STARGAZERS }
      ) {
        totalCount
        nodes {
          createdAt
          stargazers { totalCount }
          languages(first: 2, orderBy: { direction: DESC, field: SIZE }) {
            nodes { name }
          }
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// GitHub API client — retries across tokens on rate-limit
// ---------------------------------------------------------------------------

async function fetchGitHubUser(username, tokens, apiUrl) {
  let lastErr = new Error("No tokens provided");

  for (const token of tokens) {
    try {
      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `bearer ${token}`,
          "User-Agent": "github-profile-trophy-worker/1.0",
        },
        body: JSON.stringify({ query: QUERY_USER_ALL, variables: { username } }),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        const isRate = resp.status === 403 || resp.status === 429 ||
          body.toLowerCase().includes("rate limit");
        const err = new Error(isRate ? "rate_limit" : "http_error");
        err.kind = isRate ? "RATE_LIMIT" : "NOT_FOUND";
        err.status = isRate ? 429 : resp.status;
        if (!isRate) { lastErr = err; break; }
        lastErr = err;
        continue; // try next token
      }

      /** @type {{ data?: { user?: object }, errors?: Array<{message:string,type:string}> }} */
      const json = await resp.json();

      if (json.errors?.some((e) => e.type?.includes("RATE_LIMITED"))) {
        lastErr = Object.assign(new Error("rate_limit"), { kind: "RATE_LIMIT", status: 429 });
        continue;
      }

      if (!json.data?.user) {
        lastErr = Object.assign(new Error("user_not_found"), { kind: "NOT_FOUND", status: 404 });
        break;
      }

      return json.data.user;
    } catch (networkErr) {
      lastErr = networkErr;
      break;
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// UserInfo — derives trophy scores from raw API data
// ---------------------------------------------------------------------------

class UserInfo {
  constructor(data) {
    const totalCommits =
      (data.contributionsCollection.restrictedContributionsCount || 0) +
      (data.contributionsCollection.totalCommitContributions || 0);

    const totalStargazers = data.repositories.nodes.reduce(
      (sum, n) => sum + (n.stargazers?.totalCount || 0), 0,
    );

    const languages = new Set();
    data.repositories.nodes.forEach((node) => {
      node.languages?.nodes?.forEach((lang) => {
        if (lang?.name) languages.add(lang.name);
      });
    });

    // Find earliest repo creation date (or account creation date)
    let earliestDate = data.createdAt;
    for (const node of data.repositories.nodes) {
      if (node.createdAt && new Date(node.createdAt) < new Date(earliestDate)) {
        earliestDate = node.createdAt;
      }
    }

    const durationMs = Date.now() - new Date(earliestDate).getTime();
    const durationYear = new Date(durationMs).getUTCFullYear() - 1970;
    const durationDays = Math.floor(durationMs / (1000 * 60 * 60 * 24) / 100);
    const earliestYear = new Date(earliestDate).getFullYear();

    this.totalCommits      = totalCommits;
    this.totalFollowers    = data.followers?.totalCount || 0;
    this.totalIssues       = (data.openIssues?.totalCount || 0) + (data.closedIssues?.totalCount || 0);
    this.totalOrganizations = data.organizations?.totalCount || 0;
    this.totalPullRequests = data.pullRequests?.totalCount || 0;
    this.totalReviews      = data.contributionsCollection.totalPullRequestReviewContributions || 0;
    this.totalStargazers   = totalStargazers;
    this.totalRepositories = data.repositories?.totalCount || 0;
    this.languageCount     = languages.size;
    this.durationYear      = durationYear;
    this.durationDays      = durationDays;
    this.ancientAccount    = earliestYear <= 2010 ? 1 : 0;
    this.joined2020        = earliestYear === 2020 ? 1 : 0;
    this.ogAccount         = earliestYear <= 2008 ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// Trophy base class
// ---------------------------------------------------------------------------

class RankCondition {
  constructor(rank, message, requiredScore) {
    this.rank = rank;
    this.message = message;
    this.requiredScore = requiredScore;
  }
}

class Trophy {
  constructor(score, rankConditions) {
    this.score = score;
    this.rankConditions = rankConditions;
    this.rank = RANK.UNKNOWN;
    this.rankCondition = null;
    this.topMessage = "Unknown";
    this.bottomMessage = abridgeScore(score);
    this.title = "";
    this.filterTitles = [];
    this.hidden = false;
    this._setRank();
  }

  _setRank() {
    // Sort conditions best-to-worst so find() returns the best applicable rank
    const sorted = [...this.rankConditions].sort(
      (a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank),
    );
    const cond = sorted.find((r) => this.score >= r.requiredScore);
    if (cond) {
      this.rank = cond.rank;
      this.rankCondition = cond;
      this.topMessage = cond.message;
    }
  }

  _nextRankPercentage() {
    if (this.rank === RANK.UNKNOWN) return 0;
    if (this.rank === RANK.SSS) return 1;
    const nextIdx = RANK_ORDER.indexOf(this.rank) - 1;
    if (nextIdx < 0) return 1;
    const nextRank = RANK_ORDER[nextIdx];
    const nextCond = this.rankConditions.find((r) => r.rank === nextRank);
    if (!nextCond || !this.rankCondition) return 0;
    const distance = nextCond.requiredScore - this.rankCondition.requiredScore;
    if (distance <= 0) return 1;
    return Math.min(1, (this.score - this.rankCondition.requiredScore) / distance);
  }

  render(theme, x = 0, y = 0, panelSize = DEFAULT_PANEL_SIZE, noBg = false, noFrame = false) {
    const bar = nextRankBarSvg(this.title, this._nextRankPercentage(), theme.NEXT_RANK_BAR);
    const icon = trophyIconSvg(theme, this.rank);
    return `
      <svg x="${x}" y="${y}" width="${panelSize}" height="${panelSize}"
        viewBox="0 0 ${panelSize} ${panelSize}" fill="none"
        xmlns="http://www.w3.org/2000/svg">
        <rect x="0.5" y="0.5" rx="4.5"
          width="${panelSize - 1}" height="${panelSize - 1}"
          stroke="#e1e4e8" fill="${theme.BACKGROUND}"
          stroke-opacity="${noFrame ? "0" : "1"}"
          fill-opacity="${noBg ? "0" : "1"}"/>
        ${icon}
        <text x="50%" y="18" text-anchor="middle"
          font-family="Segoe UI,Helvetica,Arial,sans-serif,Apple Color Emoji,Segoe UI Emoji"
          font-weight="bold" font-size="13" fill="${theme.TITLE}">${escXml(this.title)}</text>
        <text x="50%" y="85" text-anchor="middle"
          font-family="Segoe UI,Helvetica,Arial,sans-serif,Apple Color Emoji,Segoe UI Emoji"
          font-weight="bold" font-size="10.5" fill="${theme.TEXT}">${escXml(this.topMessage)}</text>
        <text x="50%" y="97" text-anchor="middle"
          font-family="Segoe UI,Helvetica,Arial,sans-serif,Apple Color Emoji,Segoe UI Emoji"
          font-weight="bold" font-size="10" fill="${theme.TEXT}">${escXml(this.bottomMessage)}</text>
        ${bar}
      </svg>`;
  }
}

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------

function escXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function abridgeScore(score) {
  if (Math.abs(score) < 1) return "0pt";
  if (Math.abs(score) > 999) {
    return (Math.sign(score) * (Math.abs(score) / 1000)).toFixed(1) + "kpt";
  }
  return (Math.sign(score) * Math.abs(score)) + "pt";
}

function nextRankBarSvg(title, pct, color) {
  const maxW = 80;
  const filled = (maxW * pct).toFixed(1);
  // Use CSS animation via a <style> block scoped by a unique animation name
  const animName = `rankAnim_${title.replace(/\W/g, "")}`;
  return `
    <style>
      @keyframes ${animName} { from { width: 0px; } to { width: ${filled}px; } }
      #prog_${title.replace(/\W/g, "")} { animation: ${animName} 1s forwards ease-in-out; }
    </style>
    <rect x="15" y="101" rx="1" width="${maxW}" height="3.2" opacity="0.3" fill="${color}"/>
    <rect id="prog_${title.replace(/\W/g, "")}" x="15" y="101" rx="1" height="3.2" fill="${color}"/>`;
}

function trophyIconSvg(theme, rank) {
  let base, shadow, rankText;

  if (rank === RANK.SSS || rank === RANK.SS || rank === RANK.S) {
    base = theme.S_RANK_BASE; shadow = theme.S_RANK_SHADOW; rankText = rank;
  } else if (rank === RANK.AAA || rank === RANK.AA || rank === RANK.A) {
    base = theme.A_RANK_BASE; shadow = theme.A_RANK_SHADOW; rankText = rank;
  } else if (rank === RANK.B) {
    base = theme.B_RANK_BASE; shadow = theme.B_RANK_SHADOW; rankText = "B";
  } else if (rank === RANK.C) {
    base = theme.DEFAULT_RANK_BASE; shadow = theme.DEFAULT_RANK_SHADOW; rankText = "C";
  } else if (rank === RANK.SECRET) {
    base = theme.SECRET_RANK_1; shadow = theme.SECRET_RANK_2; rankText = "S";
  } else {
    base = theme.DEFAULT_RANK_BASE; shadow = theme.DEFAULT_RANK_SHADOW; rankText = "?";
  }

  // Use rank string in gradId to keep it unique per-trophy-type, collision-safe in one SVG doc
  const gradId = `tg_${rank}`;

  return `
    <defs>
      <linearGradient id="${gradId}" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%"   stop-color="${base}"/>
        <stop offset="60%"  stop-color="${base}"/>
        <stop offset="100%" stop-color="${shadow}"/>
      </linearGradient>
    </defs>
    <circle cx="55" cy="56" r="22" fill="${theme.ICON_CIRCLE}"/>
    <text x="55" y="63" text-anchor="middle"
      font-family="Segoe UI,Helvetica,Arial,sans-serif"
      font-weight="bold" font-size="16"
      fill="url(#${gradId})">${escXml(rankText)}</text>`;
}

// ---------------------------------------------------------------------------
// All trophy subclasses
// ---------------------------------------------------------------------------

class TotalStarTrophy extends Trophy {
  constructor(score) {
    super(score, [
      new RankCondition(RANK.SSS, "Super Stargazer", 2000),
      new RankCondition(RANK.SS,  "High Stargazer",   700),
      new RankCondition(RANK.S,   "Stargazer",         200),
      new RankCondition(RANK.AAA, "Super Star",        100),
      new RankCondition(RANK.AA,  "High Star",          50),
      new RankCondition(RANK.A,   "You are a Star",     30),
      new RankCondition(RANK.B,   "Middle Star",        10),
      new RankCondition(RANK.C,   "First Star",          1),
    ]);
    this.title = "Stars";
    this.filterTitles = ["Star", "Stars"];
  }
}

class TotalCommitTrophy extends Trophy {
  constructor(score) {
    super(score, [
      new RankCondition(RANK.SSS, "God Committer",   4000),
      new RankCondition(RANK.SS,  "Deep Committer",  2000),
      new RankCondition(RANK.S,   "Super Committer", 1000),
      new RankCondition(RANK.AAA, "Ultra Committer",  500),
      new RankCondition(RANK.AA,  "Hyper Committer",  200),
      new RankCondition(RANK.A,   "High Committer",   100),
      new RankCondition(RANK.B,   "Middle Committer",  10),
      new RankCondition(RANK.C,   "First Commit",       1),
    ]);
    this.title = "Commits";
    this.filterTitles = ["Commit", "Commits"];
  }
}

class TotalFollowerTrophy extends Trophy {
  constructor(score) {
    super(score, [
      new RankCondition(RANK.SSS, "Super Celebrity", 1000),
      new RankCondition(RANK.SS,  "Ultra Celebrity",  400),
      new RankCondition(RANK.S,   "Hyper Celebrity",  200),
      new RankCondition(RANK.AAA, "Famous User",      100),
      new RankCondition(RANK.AA,  "Active User",       50),
      new RankCondition(RANK.A,   "Dynamic User",      20),
      new RankCondition(RANK.B,   "Many Friends",      10),
      new RankCondition(RANK.C,   "First Friend",       1),
    ]);
    this.title = "Followers";
    this.filterTitles = ["Follower", "Followers"];
  }
}

class TotalIssueTrophy extends Trophy {
  constructor(score) {
    super(score, [
      new RankCondition(RANK.SSS, "God Issuer",   1000),
      new RankCondition(RANK.SS,  "Deep Issuer",   500),
      new RankCondition(RANK.S,   "Super Issuer",  200),
      new RankCondition(RANK.AAA, "Ultra Issuer",  100),
      new RankCondition(RANK.AA,  "Hyper Issuer",   50),
      new RankCondition(RANK.A,   "High Issuer",    20),
      new RankCondition(RANK.B,   "Middle Issuer",  10),
      new RankCondition(RANK.C,   "First Issue",     1),
    ]);
    this.title = "Issues";
    this.filterTitles = ["Issue", "Issues"];
  }
}

class TotalPullRequestTrophy extends Trophy {
  constructor(score) {
    super(score, [
      new RankCondition(RANK.SSS, "God Puller",   1000),
      new RankCondition(RANK.SS,  "Deep Puller",   500),
      new RankCondition(RANK.S,   "Super Puller",  200),
      new RankCondition(RANK.AAA, "Ultra Puller",  100),
      new RankCondition(RANK.AA,  "Hyper Puller",   50),
      new RankCondition(RANK.A,   "High Puller",    20),
      new RankCondition(RANK.B,   "Middle Puller",  10),
      new RankCondition(RANK.C,   "First Pull",      1),
    ]);
    this.title = "PullRequest";
    this.filterTitles = ["PR", "PullRequest", "Pulls", "Puller"];
  }
}

class TotalRepositoryTrophy extends Trophy {
  constructor(score) {
    super(score, [
      new RankCondition(RANK.SSS, "God Repo Creator",    50),
      new RankCondition(RANK.SS,  "Deep Repo Creator",   45),
      new RankCondition(RANK.S,   "Super Repo Creator",  40),
      new RankCondition(RANK.AAA, "Ultra Repo Creator",  35),
      new RankCondition(RANK.AA,  "Hyper Repo Creator",  30),
      new RankCondition(RANK.A,   "High Repo Creator",   20),
      new RankCondition(RANK.B,   "Middle Repo Creator", 10),
      new RankCondition(RANK.C,   "First Repository",     1),
    ]);
    this.title = "Repositories";
    this.filterTitles = ["Repo", "Repository", "Repositories"];
  }
}

class TotalReviewsTrophy extends Trophy {
  constructor(score) {
    super(score, [
      new RankCondition(RANK.SSS, "God Reviewer",          70),
      new RankCondition(RANK.SS,  "Deep Reviewer",         57),
      new RankCondition(RANK.S,   "Super Reviewer",        45),
      new RankCondition(RANK.AAA, "Ultra Reviewer",        30),
      new RankCondition(RANK.AA,  "Hyper Reviewer",        20),
      new RankCondition(RANK.A,   "Active Reviewer",        8),
      new RankCondition(RANK.B,   "Intermediate Reviewer",  3),
      new RankCondition(RANK.C,   "New Reviewer",           1),
    ]);
    this.title = "Reviews";
    this.filterTitles = ["Review", "Reviews"];
  }
}

class AccountDurationTrophy extends Trophy {
  constructor(score) {
    super(score, [
      new RankCondition(RANK.SSS, "Seasoned Veteran", 70),
      new RankCondition(RANK.SS,  "Grandmaster",      55),
      new RankCondition(RANK.S,   "Master Dev",       40),
      new RankCondition(RANK.AAA, "Expert Dev",       28),
      new RankCondition(RANK.AA,  "Experienced Dev",  18),
      new RankCondition(RANK.A,   "Intermediate Dev", 11),
      new RankCondition(RANK.B,   "Junior Dev",        6),
      new RankCondition(RANK.C,   "Newbie",            2),
    ]);
    this.title = "Experience";
    this.filterTitles = ["Experience", "Duration", "Since"];
  }
}

// Secret trophies

class AllSuperRankTrophy extends Trophy {
  constructor(score) {
    super(score, [new RankCondition(RANK.SECRET, "S Rank Hacker", 1)]);
    this.title = "AllSuperRank";
    this.filterTitles = ["AllSuperRank"];
    this.bottomMessage = "All S Rank";
    this.hidden = true;
  }
}

class MultipleLangTrophy extends Trophy {
  constructor(score) {
    super(score, [new RankCondition(RANK.SECRET, "Rainbow Lang User", 10)]);
    this.title = "MultiLanguage";
    this.filterTitles = ["MultipleLang", "MultiLanguage"];
    this.hidden = true;
  }
}

class LongTimeAccountTrophy extends Trophy {
  constructor(score) {
    super(score, [new RankCondition(RANK.SECRET, "Village Elder", 10)]);
    this.title = "LongTimeUser";
    this.filterTitles = ["LongTimeUser"];
    this.hidden = true;
  }
}

class AncientAccountTrophy extends Trophy {
  constructor(score) {
    super(score, [new RankCondition(RANK.SECRET, "Ancient User", 1)]);
    this.title = "AncientUser";
    this.filterTitles = ["AncientUser"];
    this.bottomMessage = "Before 2010";
    this.hidden = true;
  }
}

class OGAccountTrophy extends Trophy {
  constructor(score) {
    super(score, [new RankCondition(RANK.SECRET, "OG User", 1)]);
    this.title = "OGUser";
    this.filterTitles = ["OGUser"];
    this.bottomMessage = "Joined 2008";
    this.hidden = true;
  }
}

class Joined2020Trophy extends Trophy {
  constructor(score) {
    super(score, [new RankCondition(RANK.SECRET, "Everything started...", 1)]);
    this.title = "Joined2020";
    this.filterTitles = ["Joined2020"];
    this.bottomMessage = "Joined 2020";
    this.hidden = true;
  }
}

class MultipleOrganizationsTrophy extends Trophy {
  constructor(score) {
    super(score, [new RankCondition(RANK.SECRET, "Jack of all Trades", 3)]);
    this.title = "Organizations";
    this.filterTitles = ["Organizations", "Orgs", "Teams"];
    this.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// TrophyList — builds, filters, sorts collection
// ---------------------------------------------------------------------------

class TrophyList {
  constructor(userInfo) {
    const base = [
      new TotalStarTrophy(userInfo.totalStargazers),
      new TotalCommitTrophy(userInfo.totalCommits),
      new TotalFollowerTrophy(userInfo.totalFollowers),
      new TotalIssueTrophy(userInfo.totalIssues),
      new TotalPullRequestTrophy(userInfo.totalPullRequests),
      new TotalRepositoryTrophy(userInfo.totalRepositories),
      new TotalReviewsTrophy(userInfo.totalReviews),
    ];

    const isAllSRank = base.every((t) => t.rank.startsWith(RANK.S)) ? 1 : 0;

    const secret = [
      new AllSuperRankTrophy(isAllSRank),
      new MultipleLangTrophy(userInfo.languageCount),
      new LongTimeAccountTrophy(userInfo.durationYear),
      new AncientAccountTrophy(userInfo.ancientAccount),
      new OGAccountTrophy(userInfo.ogAccount),
      new Joined2020Trophy(userInfo.joined2020),
      new MultipleOrganizationsTrophy(userInfo.totalOrganizations),
      new AccountDurationTrophy(userInfo.durationDays),
    ];

    this.trophies = [...base, ...secret];
  }

  get length() { return this.trophies.length; }
  get getArray() { return this.trophies; }

  filterByHidden() {
    this.trophies = this.trophies.filter((t) => !t.hidden || t.rank !== RANK.UNKNOWN);
  }

  filterByTitles(titles) {
    this.trophies = this.trophies.filter((t) =>
      t.filterTitles.some((ft) => titles.includes(ft)),
    );
  }

  filterByRanks(ranks) {
    if (ranks.some((r) => r.startsWith("-"))) {
      const excluded = ranks.filter((r) => r.startsWith("-")).map((r) => r.slice(1));
      this.trophies = this.trophies.filter((t) => !excluded.includes(t.rank));
      return;
    }
    this.trophies = this.trophies.filter((t) => ranks.includes(t.rank));
  }

  filterByExclusionTitles(titles) {
    const excluded = titles.filter((t) => t.startsWith("-")).map((t) => t.slice(1));
    if (excluded.length > 0) {
      this.trophies = this.trophies.filter((t) => !excluded.includes(t.title));
    }
  }

  sortByRank() {
    this.trophies = [...this.trophies].sort(
      (a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank),
    );
  }
}

// ---------------------------------------------------------------------------
// Card — assembles trophy grid SVG
// ---------------------------------------------------------------------------

class Card {
  constructor({ titles, ranks, column, row, marginWidth, marginHeight, noBackground, noFrame }) {
    this.titles = titles;
    this.ranks = ranks;
    this.maxColumn = column;
    this.maxRow = row;
    this.marginWidth = marginWidth;
    this.marginHeight = marginHeight;
    this.noBackground = noBackground;
    this.noFrame = noFrame;
    this.panelSize = DEFAULT_PANEL_SIZE;
    this.width = this.panelSize * this.maxColumn + this.marginWidth * (this.maxColumn - 1);
  }

  render(userInfo, theme) {
    const list = new TrophyList(userInfo);
    list.filterByHidden();

    if (this.titles.length > 0) {
      const inc = this.titles.filter((t) => !t.startsWith("-"));
      if (inc.length > 0) list.filterByTitles(inc);
      list.filterByExclusionTitles(this.titles);
    }

    if (this.ranks.length > 0) list.filterByRanks(this.ranks);

    list.sortByRank();

    // column === -1 → auto-fit all in one row
    if (this.maxColumn === -1) {
      this.maxColumn = list.length || 1;
      this.width = this.panelSize * this.maxColumn + this.marginWidth * (this.maxColumn - 1);
    }

    const rowCount = Math.min(
      this.maxRow,
      list.length === 0 ? 1 : Math.ceil(list.length / this.maxColumn),
    );
    const height = this.panelSize * rowCount + this.marginHeight * (rowCount - 1);

    const trophySvgs = list.getArray.reduce((acc, trophy, i) => {
      const col = i % this.maxColumn;
      const row = Math.floor(i / this.maxColumn);
      const x = this.panelSize * col + this.marginWidth * col;
      const y = this.panelSize * row + this.marginHeight * row;
      return acc + trophy.render(theme, x, y, this.panelSize, this.noBackground, this.noFrame);
    }, "");

    return `<svg width="${this.width}" height="${height}"
      viewBox="0 0 ${this.width} ${height}"
      fill="none" xmlns="http://www.w3.org/2000/svg">
      ${trophySvgs}
    </svg>`;
  }
}

// ---------------------------------------------------------------------------
// Theme palettes
// ---------------------------------------------------------------------------

const THEMES = {
  default: {
    BACKGROUND: "#FFF", TITLE: "#000", ICON_CIRCLE: "#FFF", TEXT: "#666",
    LAUREL: "#009366", SECRET_RANK_1: "red", SECRET_RANK_2: "fuchsia", SECRET_RANK_3: "blue",
    SECRET_RANK_TEXT: "fuchsia", NEXT_RANK_BAR: "#0366d6",
    S_RANK_BASE: "#FAD200", S_RANK_SHADOW: "#C8A090", S_RANK_TEXT: "#886000",
    A_RANK_BASE: "#B0B0B0", A_RANK_SHADOW: "#9090C0", A_RANK_TEXT: "#505050",
    B_RANK_BASE: "#A18D66", B_RANK_SHADOW: "#816D96", B_RANK_TEXT: "#412D06",
    DEFAULT_RANK_BASE: "#777", DEFAULT_RANK_SHADOW: "#333", DEFAULT_RANK_TEXT: "#333",
  },
  dracula: {
    BACKGROUND: "#282a36", TITLE: "#ff79c6", ICON_CIRCLE: "#f8f8f2", TEXT: "#f8f8f2",
    LAUREL: "#50fa7b", SECRET_RANK_1: "#ff5555", SECRET_RANK_2: "#ff79c6", SECRET_RANK_3: "#bd93f9",
    SECRET_RANK_TEXT: "#bd93f9", NEXT_RANK_BAR: "#ff79c6",
    S_RANK_BASE: "#ffb86c", S_RANK_SHADOW: "#ffb86c", S_RANK_TEXT: "#6272a4",
    A_RANK_BASE: "#8be9fd", A_RANK_SHADOW: "#8be9fd", A_RANK_TEXT: "#6272a4",
    B_RANK_BASE: "#ff5555", B_RANK_SHADOW: "#ff5555", B_RANK_TEXT: "#6272a4",
    DEFAULT_RANK_BASE: "#6272a4", DEFAULT_RANK_SHADOW: "#6272a4", DEFAULT_RANK_TEXT: "#6272a4",
  },
  flat: {
    BACKGROUND: "#FFF", TITLE: "#000", ICON_CIRCLE: "#FFF", TEXT: "#666",
    LAUREL: "#009366", SECRET_RANK_1: "red", SECRET_RANK_2: "fuchsia", SECRET_RANK_3: "blue",
    SECRET_RANK_TEXT: "fuchsia", NEXT_RANK_BAR: "#0366d6",
    S_RANK_BASE: "#eac200", S_RANK_SHADOW: "#eac200", S_RANK_TEXT: "#886000",
    A_RANK_BASE: "#B0B0B0", A_RANK_SHADOW: "#B0B0B0", A_RANK_TEXT: "#505050",
    B_RANK_BASE: "#A18D66", B_RANK_SHADOW: "#A18D66", B_RANK_TEXT: "#412D06",
    DEFAULT_RANK_BASE: "#777", DEFAULT_RANK_SHADOW: "#777", DEFAULT_RANK_TEXT: "#333",
  },
  onedark: {
    BACKGROUND: "#282c34", TITLE: "#e5c07b", ICON_CIRCLE: "#FFF", TEXT: "#e06c75",
    LAUREL: "#98c379", SECRET_RANK_1: "#e06c75", SECRET_RANK_2: "#c678dd", SECRET_RANK_3: "#61afef",
    SECRET_RANK_TEXT: "#c678dd", NEXT_RANK_BAR: "#e5c07b",
    S_RANK_BASE: "#e5c07b", S_RANK_SHADOW: "#e5c07b", S_RANK_TEXT: "#282c34",
    A_RANK_BASE: "#56b6c2", A_RANK_SHADOW: "#56b6c2", A_RANK_TEXT: "#282c34",
    B_RANK_BASE: "#c678dd", B_RANK_SHADOW: "#c678dd", B_RANK_TEXT: "#282c34",
    DEFAULT_RANK_BASE: "#abb2bf", DEFAULT_RANK_SHADOW: "#abb2bf", DEFAULT_RANK_TEXT: "#282c34",
  },
  nord: {
    BACKGROUND: "#2E3440", TITLE: "#81A1C1", ICON_CIRCLE: "#D8DEE9", TEXT: "#ECEFF4",
    LAUREL: "#A3BE8C", SECRET_RANK_1: "#BF616A", SECRET_RANK_2: "#B48EAD", SECRET_RANK_3: "#81A1C1",
    SECRET_RANK_TEXT: "#B48EAD", NEXT_RANK_BAR: "#81A1C1",
    S_RANK_BASE: "#EBCB8B", S_RANK_SHADOW: "#EBCB8B", S_RANK_TEXT: "#3B4252",
    A_RANK_BASE: "#8FBCBB", A_RANK_SHADOW: "#8FBCBB", A_RANK_TEXT: "#3B4252",
    B_RANK_BASE: "#D08770", B_RANK_SHADOW: "#D08770", B_RANK_TEXT: "#3B4252",
    DEFAULT_RANK_BASE: "#5E81AC", DEFAULT_RANK_SHADOW: "#5E81AC", DEFAULT_RANK_TEXT: "#3B4252",
  },
  radical: {
    BACKGROUND: "#141321", ICON_CIRCLE: "#EEEEEE", TITLE: "#fe428e", TEXT: "#a9fef7",
    LAUREL: "#50fa7b", SECRET_RANK_1: "#ff5555", SECRET_RANK_2: "#ff15d9", SECRET_RANK_3: "#1E65F5",
    SECRET_RANK_TEXT: "#ff61c6", NEXT_RANK_BAR: "#fe428e",
    S_RANK_BASE: "#ffce32", S_RANK_SHADOW: "#ffce32", S_RANK_TEXT: "#CB8A30",
    A_RANK_BASE: "#8DF7B5", A_RANK_SHADOW: "#8DF7B5", A_RANK_TEXT: "#3A3A3A",
    B_RANK_BASE: "#EA3F25", B_RANK_SHADOW: "#EA3F25", B_RANK_TEXT: "#3A3A3A",
    DEFAULT_RANK_BASE: "#1E65F5", DEFAULT_RANK_SHADOW: "#1E65F5", DEFAULT_RANK_TEXT: "#3A3A3A",
  },
  tokyonight: {
    BACKGROUND: "#1a1b27", TITLE: "#70a5fd", ICON_CIRCLE: "#bf91f3", TEXT: "#38bdae",
    LAUREL: "#178600", SECRET_RANK_1: "#ff5555", SECRET_RANK_2: "#ff79c6", SECRET_RANK_3: "#388bfd",
    SECRET_RANK_TEXT: "#ff79c6", NEXT_RANK_BAR: "#00aeff",
    S_RANK_BASE: "#ffb86c", S_RANK_SHADOW: "#ffb86c", S_RANK_TEXT: "#0d1117",
    A_RANK_BASE: "#2dde98", A_RANK_SHADOW: "#2dde98", A_RANK_TEXT: "#0d1117",
    B_RANK_BASE: "#8be9fd", B_RANK_SHADOW: "#8be9fd", B_RANK_TEXT: "#0d1117",
    DEFAULT_RANK_BASE: "#5c75c3", DEFAULT_RANK_SHADOW: "#6272a4", DEFAULT_RANK_TEXT: "#0d1117",
  },
  darkhub: {
    BACKGROUND: "#0d1117", TITLE: "#c9d1d9", ICON_CIRCLE: "#f0f6fb", TEXT: "#8b949e",
    LAUREL: "#178600", SECRET_RANK_1: "#ff5555", SECRET_RANK_2: "#ff79c6", SECRET_RANK_3: "#388bfd",
    SECRET_RANK_TEXT: "#ff79c6", NEXT_RANK_BAR: "#ff79c6",
    S_RANK_BASE: "#ffb86c", S_RANK_SHADOW: "#ffb86c", S_RANK_TEXT: "#0d1117",
    A_RANK_BASE: "#8be9fd", A_RANK_SHADOW: "#8be9fd", A_RANK_TEXT: "#0d1117",
    B_RANK_BASE: "#ff5555", B_RANK_SHADOW: "#ff5555", B_RANK_TEXT: "#0d1117",
    DEFAULT_RANK_BASE: "#6272a4", DEFAULT_RANK_SHADOW: "#6272a4", DEFAULT_RANK_TEXT: "#0d1117",
  },
};

function resolveTheme(name) {
  return Object.prototype.hasOwnProperty.call(THEMES, name) ? THEMES[name] : THEMES.default;
}

// ---------------------------------------------------------------------------
// Error HTML helper
// ---------------------------------------------------------------------------

function errorHtml(status, title, detail = "") {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Trophy — ${status}</title>
<style>
  body{font-family:Arial,sans-serif;background:#f4f4f4;padding:20px}
  .box{background:#fff;border-radius:5px;padding:20px;max-width:620px;
       margin:40px auto;box-shadow:0 2px 8px rgba(0,0,0,.12)}
  h1{color:#333;margin-top:0}p{color:#666}
  code{background:#f0f0f0;padding:2px 6px;border-radius:3px}
</style></head>
<body><div class="box">
  <h1>${status} — ${title}</h1>
  <p>${detail}</p>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------

async function handleRequest(request, env) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const params = new URLSearchParams(url.search);

  // Helper to read params with defaults
  const getString = (k, def) => params.get(k) ?? def;
  const getInt = (k, def) => {
    const v = params.get(k);
    if (v === null) return def;
    const n = parseInt(v, 10);
    return isNaN(n) ? def : n;
  };
  const getBool = (k, def) => {
    const v = params.get(k);
    return v === null ? def : v === "true";
  };
  const getMulti = (k) =>
    params.getAll(k).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);

  const username = getString("username", null);
  if (!username) {
    const base = `${url.protocol}//${url.host}${url.pathname}`;
    return new Response(
      errorHtml(400, "Bad Request",
        `<code>username</code> is a required query parameter.<br>
         Example: <code>${base}?username=YOUR_GITHUB_USERNAME</code>`),
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  // Collect available tokens
  const tokens = [env.GITHUB_TOKEN, env.GITHUB_TOKEN2]
    .filter((t) => typeof t === "string" && t.length > 0);

  if (tokens.length === 0) {
    return new Response(
      errorHtml(500, "Server Error", "GITHUB_TOKEN secret is not configured."),
      { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  const apiUrl = (typeof env.GITHUB_API === "string" && env.GITHUB_API) || GITHUB_API_URL;

  // Fetch GitHub data
  let rawData;
  try {
    rawData = await fetchGitHubUser(username, tokens, apiUrl);
  } catch (err) {
    const isRate = err.kind === "RATE_LIMIT";
    const status = err.status || (isRate ? 429 : 502);
    return new Response(
      errorHtml(status,
        isRate ? "Rate Limit" : (err.kind === "NOT_FOUND" ? "Not Found" : "Bad Gateway"),
        isRate
          ? "GitHub API rate limit exceeded. Try again later."
          : err.kind === "NOT_FOUND"
            ? `User <code>${escXml(username)}</code> not found on GitHub.`
            : "Failed to reach GitHub API."),
      { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  // Build UserInfo and render
  const userInfo = new UserInfo(rawData);
  const theme = resolveTheme(getString("theme", "default"));

  const card = new Card({
    titles:       getMulti("title"),
    ranks:        getMulti("rank"),
    column:       getInt("column", DEFAULT_MAX_COLUMN),
    row:          getInt("row",    DEFAULT_MAX_ROW),
    marginWidth:  getInt("margin-w", DEFAULT_MARGIN_W),
    marginHeight: getInt("margin-h", DEFAULT_MARGIN_H),
    noBackground: getBool("no-bg",    DEFAULT_NO_BACKGROUND),
    noFrame:      getBool("no-frame", DEFAULT_NO_FRAME),
  });

  const cacheControl = [
    "public",
    `s-maxage=${CDN_CACHE_MAX_AGE}`,
    `stale-while-revalidate=${STALE_WHILE_REVALIDATE}`,
  ].join(", ");

  return new Response(card.render(userInfo, theme), {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": cacheControl,
    },
  });
}

// ---------------------------------------------------------------------------
// CF Workers module export
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error("Unhandled worker error:", err);
      return new Response(
        errorHtml(500, "Internal Server Error", "An unexpected error occurred."),
        { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
  },
};
