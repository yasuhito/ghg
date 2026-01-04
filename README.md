# ghg

[![npm version](https://img.shields.io/npm/v/ghg)](https://www.npmjs.com/package/ghg)

List open GitHub issues and pull requests for repositories under a directory.

## Install

```bash
npm install -g ghg
```

## Usage

```bash
npx ghg --root ../Work
```

From a local checkout:

```bash
npm install
npm run build
npx . --root ../Work
```

Options:

- `--recursive`: Scan nested repositories.
- `--no-color`: Disable colored output.

Config:

- `~/.config/ghg/config.json` with `{"root":"/path/to/root"}`
- Template: `config.example.json`

Uses `gh api` if the GitHub CLI is available.
Otherwise set `GITHUB_TOKEN` or `GH_TOKEN` to avoid GitHub API rate limits.
