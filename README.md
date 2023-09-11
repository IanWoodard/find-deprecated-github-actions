# Find Deprecated GitHub Actions

This action finds GitHub actions that have deprecation warnings.

**This should not be depended on for production use. It is merely a tool meant to help you find deprecated actions in your repository.**

## Setup

First, add a GITHUB_TOKEN environment variable to your .env file.

```sh
npm install
npm run build
```

or

```sh
yarn install
yarn build
```

## Usage

Run on all repos in a given organization:

```sh
node dist/index.js --org=<org>
```

Run on a single repo:

```sh
node dist/index.js --org=<org> --repo=<repo>
```

Run on multiple repos:

```sh
node dist/index.js --org=<org> --repos=<repo1,repo2,repo3>
```


