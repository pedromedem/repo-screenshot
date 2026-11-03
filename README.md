# Repo Screenshot

Capture desktop and mobile screenshots of the homepages linked from a GitHub user's repositories.

The tool reads `GET /users/:name/repos`, keeps repositories with an `http` or `https` homepage, and saves one JPEG per viewport.

## Prerequisites

- Node.js 18 or newer (`fetch` is part of the language runtime)

## Installation

```bash
git clone https://github.com/lucwx/repo-screenshot.git
cd repo-screenshot
npm install
```

## Usage

```bash
node index.js -n <github-username>
```

List the homepages without opening a browser:

```bash
node index.js -n lucwx --dry-run
```

Screenshots are written under `./screenshots`, relative to the current directory:

```text
screenshots/
└── example.com/
    ├── example.com_desktop.jpeg
    └── example.com_mobile.jpeg
```

Desktop captures use a 1280×720 viewport. Mobile captures use the iPhone X layout at 1× scale. JPEG quality defaults to 80. A page that fails does not stop the rest of the run; the process exits with code 1 when any capture fails.

### Options

| Flag | Default | Purpose |
| --- | --- | --- |
| `-n, --name <username>` | required | GitHub username |
| `-o, --output <dir>` | `screenshots` | Output directory |
| `-d, --delay <seconds>` | `1` | Wait after load, from 0 to 120 |
| `-q, --quality <1-100>` | `80` | JPEG quality |
| `--timeout <seconds>` | `45` | Navigation timeout per page |
| `--limit <count>` | all | Capture at most this many homepages |
| `--token <token>` | `GITHUB_TOKEN` or `GH_TOKEN` | GitHub API token |
| `--hide <selector>` | `#modal` | Selector hidden before capture. Repeat to add more. `none` hides nothing |
| `--full-page` | off | Capture the full scrollable page |
| `--dry-run` | off | Print homepages and exit |

Unauthenticated GitHub requests share a small hourly quota. Export a token when the API answers with a rate limit:

```bash
export GITHUB_TOKEN=github_pat_...
node index.js -n lucwx
```

The client follows GitHub pagination (100 repositories per page, up to 1000). Homepages without a scheme are treated as `https://`. The user's own GitHub profile URL is skipped. Duplicate homepages are captured once.

## Tests

```bash
npm test
```

The tests cover homepage filtering and the GitHub client. They do not download Chromium.

## License

ISC. See [LICENSE](LICENSE).
