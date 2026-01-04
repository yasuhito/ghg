#!/usr/bin/env node
import fs from "fs";
import path from "path";
import https from "https";
import { spawn, spawnSync } from "child_process";

const GITHUB_API_HOST = "api.github.com";

type RepoInfo = {
  activity: string;
  issues: number;
  prs: number;
  stars: number;
  releaseTag: string;
  releaseDate: string;
};

type RepoResult = RepoInfo & { repo: string };

type Args = {
  root: string;
  recursive: boolean;
  noColor: boolean;
  help?: boolean;
};

function runGit(args: string[], repoPath: string): string | null {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function ghAvailable(): boolean {
  const result = spawnSync("gh", ["--version"], { encoding: "utf8" });
  return result.status === 0;
}

function findRepos(root: string, recursive: boolean): string[] {
  const repos: string[] = [];
  const stat = fs.statSync(root, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    return repos;
  }
  if (!recursive) {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(root, entry.name);
      if (fs.existsSync(path.join(candidate, ".git"))) {
        repos.push(candidate);
      }
    }
    return repos;
  }

  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(current, entry.name);
      if (fs.existsSync(path.join(candidate, ".git"))) {
        repos.push(candidate);
        continue;
      }
      stack.push(candidate);
    }
  }
  return repos;
}

export function parseGithubOwnerRepo(
  remoteUrl: string | null
): { owner: string; name: string } | null {
  if (!remoteUrl) {
    return null;
  }
  let repoPath: string | null = null;
  if (remoteUrl.startsWith("git@github.com:")) {
    repoPath = remoteUrl.split(":", 2)[1];
  } else if (remoteUrl.includes("github.com/")) {
    repoPath = remoteUrl.split("github.com/", 2)[1];
  }
  if (!repoPath) {
    return null;
  }
  repoPath = repoPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (repoPath.endsWith(".git")) {
    repoPath = repoPath.slice(0, -4);
  }
  if (!repoPath.includes("/")) {
    return null;
  }
  const [owner, name] = repoPath.split("/", 2);
  return { owner, name };
}

export function formatRelativeTime(isoTime: string | null): string {
  if (!isoTime) {
    return "-";
  }
  const timestamp = new Date(isoTime).getTime();
  if (Number.isNaN(timestamp)) {
    return "-";
  }
  const now = Date.now();
  const deltaSeconds = Math.floor((now - timestamp) / 1000);
  if (deltaSeconds < 60) {
    return "1 min ago";
  }
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hr ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return days === 1 ? "1 day ago" : `${days} days ago`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks} wk ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months} mo ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} yr ago`;
}

function githubToken(): string | null {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

function runCommand(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const message = stderr.trim() || `${command} failed`;
        reject(new Error(message));
        return;
      }
      resolve({ stdout });
    });
  });
}

async function ghGraphqlRepoInfo(owner: string, name: string): Promise<RepoInfo> {
  const query =
    "query($owner:String!, $name:String!) {" +
    " repository(owner:$owner, name:$name) {" +
    "  stargazerCount" +
    "  issues(states:OPEN) { totalCount }" +
    "  pullRequests(states:OPEN) { totalCount }" +
    "  releases(first:1, orderBy:{field:CREATED_AT,direction:DESC}) {" +
    "    nodes { tagName createdAt }" +
    "  }" +
    "  defaultBranchRef {" +
    "    target {" +
    "      __typename" +
    "      ... on Commit { committedDate }" +
    "      ... on Tag {" +
    "        target {" +
    "          ... on Commit { committedDate }" +
    "        }" +
    "      }" +
    "    }" +
    "  }" +
    " }" +
    "}";

  const { stdout } = await runCommand("gh", [
    "api",
    "graphql",
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-f",
    `query=${query}`,
  ]);
  if (!stdout.trim()) {
    throw new Error("gh api returned no output");
  }
  const data = JSON.parse(stdout) as {
    data?: {
      repository?: {
        stargazerCount: number;
        issues: { totalCount: number };
        pullRequests: { totalCount: number };
        releases: { nodes: Array<{ tagName: string; createdAt: string }> };
        defaultBranchRef: {
          target:
            | { __typename: "Commit"; committedDate: string }
            | { __typename: "Tag"; target: { committedDate: string } };
        } | null;
      };
    };
  };
  const repoData = data.data?.repository;
  if (!repoData) {
    throw new Error("repository not found or access denied");
  }

  const releases = repoData.releases?.nodes || [];
  const releaseTag = releases[0]?.tagName || "-";
  const releaseDate = releases[0]?.createdAt
    ? releases[0].createdAt.split("T", 1)[0]
    : "-";

  let committedAt: string | null = null;
  const branch = repoData.defaultBranchRef;
  if (branch?.target) {
    const target = branch.target;
    if (target.__typename === "Commit") {
      committedAt = target.committedDate;
    } else if (target.__typename === "Tag") {
      committedAt = target.target?.committedDate || null;
    }
  }

  return {
    activity: formatRelativeTime(committedAt),
    issues: repoData.issues.totalCount,
    prs: repoData.pullRequests.totalCount,
    stars: repoData.stargazerCount,
    releaseTag,
    releaseDate,
  };
}

function requestJson<T>(
  options: https.RequestOptions,
  body?: string
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 404) {
          resolve(null);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`GitHub API error ${res.statusCode}`));
          return;
        }
        if (!data.trim()) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(data) as T);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function graphqlRepoInfo(
  owner: string,
  name: string,
  token: string
): Promise<RepoInfo> {
  const query =
    "query($owner:String!, $name:String!) {" +
    " repository(owner:$owner, name:$name) {" +
    "  stargazerCount" +
    "  issues(states:OPEN) { totalCount }" +
    "  pullRequests(states:OPEN) { totalCount }" +
    "  releases(first:1, orderBy:{field:CREATED_AT,direction:DESC}) {" +
    "    nodes { tagName createdAt }" +
    "  }" +
    "  defaultBranchRef {" +
    "    target {" +
    "      __typename" +
    "      ... on Commit { committedDate }" +
    "      ... on Tag {" +
    "        target {" +
    "          ... on Commit { committedDate }" +
    "        }" +
    "      }" +
    "    }" +
    "  }" +
    " }" +
    "}";

  const body = JSON.stringify({
    query,
    variables: { owner, name },
  });

  const data = await requestJson<{
    data?: {
      repository?: {
        stargazerCount: number;
        issues: { totalCount: number };
        pullRequests: { totalCount: number };
        releases: { nodes: Array<{ tagName: string; createdAt: string }> };
        defaultBranchRef: {
          target:
            | { __typename: "Commit"; committedDate: string }
            | { __typename: "Tag"; target: { committedDate: string } };
        } | null;
      };
    };
  }>(
    {
      method: "POST",
      host: GITHUB_API_HOST,
      path: "/graphql",
      headers: {
        "User-Agent": "ghg",
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
      },
    },
    body
  );
  const repoData = data?.data?.repository;
  if (!repoData) {
    throw new Error("repository not found or access denied");
  }
  const releases = repoData.releases?.nodes || [];
  const releaseTag = releases[0]?.tagName || "-";
  const releaseDate = releases[0]?.createdAt
    ? releases[0].createdAt.split("T", 1)[0]
    : "-";

  let committedAt: string | null = null;
  const branch = repoData.defaultBranchRef;
  if (branch?.target) {
    const target = branch.target;
    if (target.__typename === "Commit") {
      committedAt = target.committedDate;
    } else if (target.__typename === "Tag") {
      committedAt = target.target?.committedDate || null;
    }
  }

  return {
    activity: formatRelativeTime(committedAt),
    issues: repoData.issues.totalCount,
    prs: repoData.pullRequests.totalCount,
    stars: repoData.stargazerCount,
    releaseTag,
    releaseDate,
  };
}

async function restRepoInfo(
  owner: string,
  name: string,
  token: string
): Promise<RepoInfo> {
  const repo = await requestJson<{
    pushed_at?: string;
    stargazers_count?: number;
  }>({
    method: "GET",
    host: GITHUB_API_HOST,
    path: `/repos/${owner}/${name}`,
    headers: {
      "User-Agent": "ghg",
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!repo) {
    throw new Error("repository not found or access denied");
  }

  const issuesQuery = encodeURIComponent(
    `repo:${owner}/${name} type:issue state:open`
  );
  const prsQuery = encodeURIComponent(`repo:${owner}/${name} type:pr state:open`);
  const issuesResult = await requestJson<{ total_count?: number }>({
    method: "GET",
    host: GITHUB_API_HOST,
    path: `/search/issues?q=${issuesQuery}`,
    headers: {
      "User-Agent": "ghg",
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
    },
  });
  const prsResult = await requestJson<{ total_count?: number }>({
    method: "GET",
    host: GITHUB_API_HOST,
    path: `/search/issues?q=${prsQuery}`,
    headers: {
      "User-Agent": "ghg",
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
    },
  });

  const release = await requestJson<{ tag_name?: string; created_at?: string }>(
    {
      method: "GET",
      host: GITHUB_API_HOST,
      path: `/repos/${owner}/${name}/releases/latest`,
      headers: {
        "User-Agent": "ghg",
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
      },
    }
  );

  return {
    activity: formatRelativeTime(repo.pushed_at || null),
    issues: issuesResult?.total_count || 0,
    prs: prsResult?.total_count || 0,
    stars: repo.stargazers_count || 0,
    releaseTag: release?.tag_name || "-",
    releaseDate: release?.created_at
      ? release.created_at.split("T", 1)[0]
      : "-",
  };
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    root: ".",
    recursive: false,
    noColor: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = argv[i + 1] || ".";
      i += 1;
    } else if (arg === "--recursive") {
      args.recursive = true;
    } else if (arg === "--no-color") {
      args.noColor = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  return args;
}

export function loadConfigRoot(): string | null {
  const configPath = path.join(
    process.env.HOME || "",
    ".config",
    "ghg",
    "config.json"
  );
  try {
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const raw = fs.readFileSync(configPath, "utf8");
    const data = JSON.parse(raw) as { root?: string };
    if (data?.root && data.root.trim()) {
      return data.root.trim();
    }
  } catch {
    console.error(`Warning: failed to read config: ${configPath}`);
  }
  return null;
}

function printHelp(): void {
  console.log("ghg - list open issues/PRs across local GitHub repos");
  console.log("");
  console.log("Usage:");
  console.log("  ghg --root ../Work");
  console.log("");
  console.log("Options:");
  console.log("  --root PATH     Root directory to scan (default: .)");
  console.log("  --recursive     Scan repositories recursively");
  console.log("  --no-color      Disable colored output");
  console.log("");
  console.log("Config:");
  console.log('  ~/.config/ghg/config.json with {"root":"/path"}');
}

function createSpinner(enabled: boolean) {
  if (!enabled) {
    return {
      start() {},
      update() {},
      stop() {},
      pauseFor(fn: () => void) {
        fn();
      },
    };
  }

  const frames = ["-", "\\", "|", "/"];
  let index = 0;
  let text = "";
  let lastWidth = 0;
  let timer: NodeJS.Timeout | null = null;

  const render = () => {
    const frame = frames[index % frames.length];
    index += 1;
    const line = `${frame} ${text}`;
    lastWidth = Math.max(lastWidth, line.length);
    process.stderr.write(`\r${line}`);
  };

  return {
    start(initialText?: string) {
      text = initialText || "";
      render();
      timer = setInterval(render, 120);
    },
    update(nextText?: string) {
      text = nextText || "";
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (lastWidth) {
        process.stderr.write(`\r${" ".repeat(lastWidth)}\r`);
      }
    },
    pauseFor(fn: () => void) {
      this.stop();
      fn();
      this.start(text);
    },
  };
}

export async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const configRoot = loadConfigRoot();
  const rootValue = args.root !== "." ? args.root : configRoot || ".";
  const root = path.resolve(process.cwd(), rootValue);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`Root directory not found: ${root}`);
    return 1;
  }

  const useGh = ghAvailable();
  const token = githubToken();
  if (!useGh && !token) {
    console.error(
      "Warning: GITHUB_TOKEN/GH_TOKEN not set; GitHub API rate limits apply."
    );
  }

  const repos = findRepos(root, args.recursive).sort();
  if (!repos.length) {
    console.log(`No git repositories found under ${root}`);
    return 0;
  }

  const useColor = process.stdout.isTTY && !args.noColor;
  const colors = useColor
    ? {
        reset: "\x1b[0m",
        bold: "\x1b[1m",
        white: "\x1b[37m",
        cyan: "\x1b[36m",
        red: "\x1b[31m",
        yellow: "\x1b[33m",
        darkMagenta: "\x1b[35m",
        brightRed: "\x1b[91m",
      }
    : {
        reset: "",
        bold: "",
        white: "",
        cyan: "",
        red: "",
        yellow: "",
        darkMagenta: "",
        brightRed: "",
      };

  const results: RepoResult[] = [];
  const spinner = createSpinner(process.stderr.isTTY);
  spinner.start(`Scanning ${repos.length} repositories`);
  for (let i = 0; i < repos.length; i += 1) {
    const repoPath = repos[i];
    const remote = runGit(["config", "--get", "remote.origin.url"], repoPath);
    const info = parseGithubOwnerRepo(remote);
    if (!info) {
      continue;
    }
    spinner.update(`Fetching ${i + 1}/${repos.length}: ${info.owner}/${info.name}`);
    try {
      const repoInfo = useGh
        ? await ghGraphqlRepoInfo(info.owner, info.name)
        : await graphqlRepoInfo(info.owner, info.name, token || "").catch(
            async () => {
              if (!token) {
                throw new Error("GITHUB_TOKEN/GH_TOKEN is required without gh");
              }
              return restRepoInfo(info.owner, info.name, token);
            }
          );
      results.push({
        repo: `${info.owner}/${info.name}`,
        activity: repoInfo.activity,
        issues: repoInfo.issues,
        prs: repoInfo.prs,
        stars: repoInfo.stars,
        releaseTag: repoInfo.releaseTag,
        releaseDate: repoInfo.releaseDate,
      });
    } catch (err) {
      spinner.pauseFor(() => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  Error: ${message}`);
      });
    }
  }
  spinner.stop();

  if (!results.length) {
    return 0;
  }

  const widths = {
    activity: Math.max(
      "ACTIVITY".length,
      ...results.map((item) => item.activity.length)
    ),
    issues: Math.max(
      "ISSUES".length,
      ...results.map((item) => String(item.issues).length)
    ),
    prs: Math.max(
      "PR".length,
      ...results.map((item) => String(item.prs).length)
    ),
    stars: Math.max(
      "STAR".length,
      ...results.map((item) => String(item.stars).length)
    ),
    rel: Math.max(
      "REL".length,
      ...results.map((item) => item.releaseTag.length)
    ),
    released: Math.max(
      "RELEASED".length,
      ...results.map((item) => item.releaseDate.length)
    ),
    repo: Math.max("REPO".length, ...results.map((item) => item.repo.length)),
  };

  const header =
    `${colors.bold}${colors.white}` +
    `${"ACTIVITY".padEnd(widths.activity)}  ` +
    `${"ISSUES".padStart(widths.issues)}  ` +
    `${"PR".padStart(widths.prs)}  ` +
    `${"STAR".padStart(widths.stars)}  ` +
    `${"REL".padEnd(widths.rel)}  ` +
    `${"RELEASED".padEnd(widths.released)}  ` +
    `${"REPO".padEnd(widths.repo)}` +
    `${colors.reset}`;
  console.log(header);

  for (const item of results) {
    const zeroColor = colors.darkMagenta;
    const issuesColor = item.issues > 0 ? colors.red : zeroColor;
    const prsColor = item.prs > 0 ? colors.brightRed : zeroColor;
    const starsColor = item.stars > 0 ? colors.yellow : zeroColor;
    const relColor = item.releaseTag !== "-" ? colors.white : zeroColor;
    const releasedColor = item.releaseDate !== "-" ? colors.white : zeroColor;

    const line =
      `${colors.darkMagenta}${item.activity.padEnd(widths.activity)}${colors.reset}  ` +
      `${issuesColor}${String(item.issues).padStart(widths.issues)}${colors.reset}  ` +
      `${prsColor}${String(item.prs).padStart(widths.prs)}${colors.reset}  ` +
      `${starsColor}${String(item.stars).padStart(widths.stars)}${colors.reset}  ` +
      `${relColor}${item.releaseTag.padEnd(widths.rel)}${colors.reset}  ` +
      `${releasedColor}${item.releaseDate.padEnd(widths.released)}${colors.reset}  ` +
      `${colors.cyan}${item.repo.padEnd(widths.repo)}${colors.reset}`;
    console.log(line);
  }

  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(message);
      process.exit(1);
    });
}
