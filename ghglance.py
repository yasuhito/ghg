#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import sys
import shutil
from datetime import datetime, timezone
from pathlib import Path
from urllib import error, request


GITHUB_API_BASE = "https://api.github.com"
LINK_NEXT_RE = re.compile(r'<([^>]+)>;\s*rel="next"')


def run_git(args, repo_path):
    result = subprocess.run(
        ["git", "-C", str(repo_path), *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def find_repos(root, recursive=False):
    if recursive:
        for path in root.rglob(".git"):
            yield path.parent
    else:
        for child in root.iterdir():
            if (child / ".git").exists():
                yield child


def parse_github_owner_repo(remote_url):
    if not remote_url:
        return None
    if remote_url.startswith("git@github.com:"):
        path = remote_url.split(":", 1)[1]
    elif "github.com/" in remote_url:
        path = remote_url.split("github.com/", 1)[1]
    else:
        return None
    path = path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    if "/" not in path:
        return None
    return path.split("/", 1)


def github_token():
    return os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")


def gh_available():
    return shutil.which("gh") is not None


def format_relative_time(iso_time):
    if not iso_time:
        return "-"
    dt = datetime.fromisoformat(iso_time.replace("Z", "+00:00"))
    now = datetime.now(timezone.utc)
    delta = now - dt
    seconds = int(delta.total_seconds())
    if seconds < 60:
        return "1 min ago"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} min ago"
    hours = minutes // 60
    if hours < 24:
        return f"{hours} hr ago" if hours == 1 else f"{hours} hr ago"
    days = hours // 24
    if days < 7:
        return f"{days} day ago" if days == 1 else f"{days} days ago"
    weeks = days // 7
    if weeks < 5:
        return f"{weeks} wk ago" if weeks == 1 else f"{weeks} wk ago"
    months = days // 30
    if months < 12:
        return f"{months} mo ago" if months == 1 else f"{months} mo ago"
    years = days // 365
    return f"{years} yr ago" if years == 1 else f"{years} yr ago"


def gh_graphql_repo_info(owner, repo):
    query = (
        "query($owner:String!, $name:String!) {"
        " repository(owner:$owner, name:$name) {"
        "  stargazerCount"
        "  issues(states:OPEN) { totalCount }"
        "  pullRequests(states:OPEN) { totalCount }"
        "  releases(first:1, orderBy:{field:CREATED_AT,direction:DESC}) {"
        "    nodes { tagName createdAt }"
        "  }"
        "  defaultBranchRef {"
        "    target {"
        "      __typename"
        "      ... on Commit { committedDate }"
        "      ... on Tag {"
        "        target {"
        "          ... on Commit { committedDate }"
        "        }"
        "      }"
        "    }"
        "  }"
        " }"
        "}"
    )
    args = [
        "gh",
        "api",
        "graphql",
        "-f",
        f"owner={owner}",
        "-f",
        f"name={repo}",
        "-f",
        f"query={query}",
    ]
    result = subprocess.run(
        args,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "gh api failed")
    if not result.stdout.strip():
        raise RuntimeError(result.stderr.strip() or "gh api returned no output")
    data = json.loads(result.stdout)
    repo_data = data.get("data", {}).get("repository")
    if not repo_data:
        raise RuntimeError("repository not found or access denied")
    issues_count = repo_data["issues"]["totalCount"]
    prs_count = repo_data["pullRequests"]["totalCount"]
    stars = repo_data.get("stargazerCount", 0)
    releases = repo_data.get("releases", {}).get("nodes", [])
    release_tag = "-"
    release_date = "-"
    if releases:
        release_tag = releases[0].get("tagName") or "-"
        created_at = releases[0].get("createdAt")
        if created_at:
            release_date = created_at.split("T", 1)[0]
    committed_at = None
    branch = repo_data.get("defaultBranchRef")
    if branch and branch.get("target"):
        target = branch["target"]
        if target.get("__typename") == "Commit":
            committed_at = target.get("committedDate")
        elif target.get("__typename") == "Tag":
            tag_target = target.get("target") or {}
            committed_at = tag_target.get("committedDate")
    activity = format_relative_time(committed_at)
    return {
        "issues": issues_count,
        "prs": prs_count,
        "stars": stars,
        "release_tag": release_tag,
        "release_date": release_date,
        "activity": activity,
    }


def github_get(owner, repo, endpoint, params, token):
    query = "&".join([f"{k}={v}" for k, v in params.items()])
    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/{endpoint}?{query}"
    items = []
    while url:
        headers = {"Accept": "application/vnd.github+json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = request.Request(url, headers=headers)
        try:
            with request.urlopen(req) as resp:
                body = resp.read().decode("utf-8")
                items.extend(json.loads(body))
                link = resp.headers.get("Link", "")
                match = LINK_NEXT_RE.search(link)
                url = match.group(1) if match else None
        except error.HTTPError as exc:
            raise RuntimeError(f"GitHub API error {exc.code}: {exc.reason}") from exc
    return items


def github_get_json(owner, repo, endpoint, params, token):
    query = "&".join([f"{k}={v}" for k, v in params.items()]) if params else ""
    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/{endpoint}"
    if query:
        url = f"{url}?{query}"
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = request.Request(url, headers=headers)
    try:
        with request.urlopen(req) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise RuntimeError(f"GitHub API error {exc.code}: {exc.reason}") from exc


def main():
    parser = argparse.ArgumentParser(
        description="List open issues and pull requests for GitHub repos under a directory."
    )
    parser.add_argument(
        "--root",
        default=".",
        help="Root directory to scan (default: current directory)",
    )
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Scan repositories recursively",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable colored output",
    )
    args = parser.parse_args()

    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"Root directory not found: {root}", file=sys.stderr)
        return 1

    token = github_token()
    use_gh = gh_available()
    if not use_gh and not token:
        print(
            "Warning: GITHUB_TOKEN/GH_TOKEN not set; GitHub API rate limits apply.",
            file=sys.stderr,
        )

    repos = list(find_repos(root, args.recursive))
    if not repos:
        print(f"No git repositories found under {root}")
        return 0

    use_color = sys.stdout.isatty() and not args.no_color
    if use_color:
        reset = "\033[0m"
        dim = "\033[2m"
        bold = "\033[1m"
        cyan = "\033[36m"
        red = "\033[31m"
        green = "\033[32m"
        yellow = "\033[33m"
        white = "\033[37m"
        dark_blue = "\033[35m"
        bright_red = "\033[91m"
    else:
        reset = dim = bold = cyan = red = green = yellow = white = dark_blue = bright_red = ""

    results = []
    for repo_path in sorted(repos):
        remote_url = run_git(["config", "--get", "remote.origin.url"], repo_path)
        owner_repo = parse_github_owner_repo(remote_url)
        if not owner_repo:
            continue
        owner, repo = owner_repo

        try:
            if use_gh:
                info = gh_graphql_repo_info(owner, repo)
                issues_count = info["issues"]
                prs_count = info["prs"]
                stars = info["stars"]
                release_tag = info["release_tag"]
                release_date = info["release_date"]
                activity = info["activity"]
            else:
                issues = github_get(
                    owner,
                    repo,
                    "issues",
                    {"state": "open", "per_page": 100},
                    token,
                )
                prs = github_get(
                    owner,
                    repo,
                    "pulls",
                    {"state": "open", "per_page": 100},
                    token,
                )
                issues = [item for item in issues if "pull_request" not in item]
                issues_count = len(issues)
                prs_count = len(prs)
                repo_info = github_get_json(owner, repo, "", None, token) or {}
                stars = repo_info.get("stargazers_count", 0)
                pushed_at = repo_info.get("pushed_at")
                activity = format_relative_time(pushed_at)
                release = github_get_json(owner, repo, "releases/latest", None, token)
                if release:
                    release_tag = release.get("tag_name") or "-"
                    created_at = release.get("created_at")
                    release_date = created_at.split("T", 1)[0] if created_at else "-"
                else:
                    release_tag = "-"
                    release_date = "-"
        except RuntimeError as exc:
            print(f"  Error: {exc}", file=sys.stderr)
            continue

        results.append(
            {
                "name": repo_path.name,
                "repo": f"{owner}/{repo}",
                "issues": issues_count,
                "prs": prs_count,
                "stars": stars,
                "release_tag": release_tag,
                "release_date": release_date,
                "activity": activity,
            }
        )

    if not results:
        return 0

    activity_width = max(len(item["activity"]) for item in results + [{"activity": "ACTIVITY"}])
    issues_width = max(len(str(item["issues"])) for item in results + [{"issues": "ISSUES"}])
    prs_width = max(len(str(item["prs"])) for item in results + [{"prs": "PR"}])
    stars_width = max(len(str(item["stars"])) for item in results + [{"stars": "STAR"}])
    rel_width = max(len(item["release_tag"]) for item in results + [{"release_tag": "REL"}])
    released_width = max(len(item["release_date"]) for item in results + [{"release_date": "RELEASED"}])
    repo_width = max(len(item["repo"]) for item in results + [{"repo": "REPO"}])

    header = (
        f"{bold}{white}"
        f"{'ACTIVITY'.ljust(activity_width)}  "
        f"{'ISSUES'.rjust(issues_width)}  "
        f"{'PR'.rjust(prs_width)}  "
        f"{'STAR'.rjust(stars_width)}  "
        f"{'REL'.ljust(rel_width)}  "
        f"{'RELEASED'.ljust(released_width)}  "
        f"{'REPO'.ljust(repo_width)}"
        f"{reset}"
    )
    print(header)

    for item in results:
        activity = item["activity"].ljust(activity_width)
        issues = str(item["issues"]).rjust(issues_width)
        prs = str(item["prs"]).rjust(prs_width)
        stars = str(item["stars"]).rjust(stars_width)
        rel = item["release_tag"].ljust(rel_width)
        released = item["release_date"].ljust(released_width)
        zero_color = dark_blue
        issues_color = red if item["issues"] > 0 else zero_color
        prs_color = bright_red if item["prs"] > 0 else zero_color
        stars_color = yellow if item["stars"] > 0 else zero_color
        rel_color = white if item["release_tag"] != "-" else zero_color
        released_color = white if item["release_date"] != "-" else zero_color
        print(
            f"{dark_blue}{activity}{reset}  "
            f"{issues_color}{issues}{reset}  "
            f"{prs_color}{prs}{reset}"
            f"  {stars_color}{stars}{reset}  "
            f"{rel_color}{rel}{reset}  "
            f"{released_color}{released}{reset}  "
            f"{cyan}{item['repo'].ljust(repo_width)}{reset}"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
