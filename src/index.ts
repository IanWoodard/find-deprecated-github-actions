import {Octokit} from '@octokit/rest';
import {throttling} from '@octokit/plugin-throttling';
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {ensureFile} from 'fs-extra';
import path from 'path';
import 'dotenv/config';
import chalk from 'chalk';
import meow from 'meow';
import ora from 'ora';

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

const CACHE_DIR = path.resolve(__dirname, '.github.cache');

const JOBS_REGEX = /jobs\/(.*)/;
const MAX_PER_PAGE = 100;

const cli = meow(
  `
  Usage
    $ node dist/index.js --org=<org> --repo=<repo>
    $ node dist/index.js --org=<org> --repos=<repo1,repo2,repo3>

  Options
    --org  The GitHub organization to check
    --repo The GitHub repository to check
    --repos A comma separated list of repositories to check
`,
  {
    importMeta: import.meta,
    flags: {
      org: {
        type: 'string',
        isRequired: true,
      },
      repo: {
        type: 'string',
      },
      repos: {
        type: 'string',
      },
    },
  }
);

const OctokitWithThrottling = Octokit.plugin(throttling);

const octokit = new OctokitWithThrottling({
  auth: process.env.GITHUB_TOKEN,
  throttle: {
    onRateLimit: (retryAfter: number, options: any) => {
      octokit.log.warn(
        `Request quota exhausted for request ${options.method} ${options.url}`
      );

      // Retry twice after hitting a rate limit error, then give up
      if (options.request.retryCount <= 2) {
        console.log(`Retrying after ${retryAfter} seconds!`);
        return true;
      }
    },
    onSecondaryRateLimit: (retryAfter: number, options: any) => {
      octokit.log.warn(
        `Secondary request quota exhausted for request ${options.method} ${options.url}`
      );

      // Retry twice after hitting a rate limit error, then give up
      if (options.request.retryCount <= 2) {
        console.log(`Retrying after ${retryAfter} seconds!`);
        return true;
      }
    },
  },
});

function isNotNull<T>(value: T | null): value is T {
  return value !== null;
}

async function checkForDeprecations(org: string, repo: string) {
  console.log(chalk.bold(chalk.whiteBright(`Checking Repo: ${repo}`)));
  const deprecationMap = new Map<string, string[]>();
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const spinner = ora('Fetching workflows').start();
  try {
    const workflows = await getCached(
      org,
      repo,
      'workflows',
      'index',
      async () => {
        const {data} = await octokit.actions.listRepoWorkflows({
          owner: org,
          repo,
        });
        return data.workflows;
      }
    );
    spinner.stop();

    for (const workflow of workflows) {
      const spinner = ora(`Checking ${workflow.name}`).start();
      const workflowRuns = await getCached(
        org,
        repo,
        'workflow-runs',
        workflow.id.toString(),
        async () => {
          const {data} = await octokit.actions.listWorkflowRuns({
            owner: org,
            repo,
            workflow_id: workflow.id,
            per_page: 10,
          });
          return data.workflow_runs;
        }
      );

      for (const run of workflowRuns) {
        const runCreatedAt = new Date(run.created_at);
        if (runCreatedAt < twoDaysAgo) {
          continue;
        }
        const checkRuns = await getCached(
          org,
          repo,
          'check-runs',
          run.id.toString(),
          async () => {
            const {data} = await octokit.checks.listForRef({
              owner: org,
              repo,
              ref: run.head_sha,
              per_page: 10,
            });
            return data.check_runs;
          }
        );

        for (const checkRun of checkRuns) {
          if (
            checkRun.status !== 'completed' ||
            checkRun.output.annotations_count === 0
          ) {
            continue;
          }

          const annotations = await getCached(
            org,
            repo,
            'annotations',
            checkRun.id.toString(),
            async () => {
              const {data} = await octokit.checks.listAnnotations({
                owner: org,
                repo,
                check_run_id: checkRun.id,
              });
              return data;
            }
          );

          const deprecations = annotations.filter((annotation) => {
            return annotation.message?.includes('deprecated');
          });

          const uniqueDeprecationMessages = [
            ...new Set(deprecations.map((deprecation) => deprecation.message)),
          ].filter(isNotNull);

          if (uniqueDeprecationMessages.length > 0) {
            for (const deprecationMessage of uniqueDeprecationMessages) {
              if (deprecationMessage && checkRun.html_url !== null) {
                console.log(deprecationMessage);
                const key = checkRun.html_url.replace(JOBS_REGEX, '');
                if (!deprecationMap.has(key)) {
                  deprecationMap.set(key, []);
                }
                if (!deprecationMap.get(key)?.includes(deprecationMessage)) {
                  deprecationMap.get(key)?.push(deprecationMessage);
                }
              }
            }
          }
        }
      }
      spinner.stop();
    }
    console.log(`  Found ${deprecationMap.size} run(s) with deprecations`);
    for (const [key, _value] of deprecationMap.entries()) {
      console.log(chalk.whiteBright(`    ${key}`));
    }
    console.log();
  } catch (e) {
    spinner.fail('Failed to fetch workflows');
    console.error(e);
    console.log();
  }
}

function getPath(
  category: string,
  owner: string,
  repo: string,
  key: string
): string {
  const timestamp = new Date().toISOString().split('T')[0];
  return path.join(CACHE_DIR, timestamp, category, owner, repo, `${key}.json`);
}

async function getCached<T>(
  owner: string,
  repo: string,
  category: string,
  key: string,
  fetcher: () => Promise<T>
): Promise<T> {
  const cacheFile = getPath(category, owner, repo, key);

  try {
    const cached = await readFile(cacheFile);
    return JSON.parse(cached.toString());
  } catch (e) {
    // ignore
  }

  const result = await fetcher();
  await ensureFile(cacheFile);
  await writeFile(cacheFile, JSON.stringify(result, null, 2));
  return result;
}

async function main(org: string) {
  if (cli.flags.repo) {
    await checkForDeprecations(org, cli.flags.repo);
    return;
  }
  if (cli.flags.repos) {
    const repos = cli.flags.repos.split(',');
    for (const repo of repos) {
      await checkForDeprecations(org, repo);
    }
    return;
  }
  const repos = [];
  let i = 0;
  // pagination doesn't seem to work well with typescript, doing it manually...
  const spinner = ora('Fetching repos').start();
  while (repos.length === MAX_PER_PAGE * i) {
    const {data} = await octokit.repos.listForOrg({
      org,
      per_page: MAX_PER_PAGE,
      page: i + 1,
    });
    repos.push(...data);
    i++;
  }
  spinner.succeed(`Found ${repos.length} repos`);

  for (const repo of repos) {
    await checkForDeprecations(org, repo.name);
  }
}

main(cli.flags.org);
