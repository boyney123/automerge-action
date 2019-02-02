const { logger, NeutralExitError } = require("./common");
const git = require("./git");

const ACTIONS = ["automerge", "autorebase"];

async function update(octokit, dir, url, pullRequest) {
  if (pullRequest.merged === true) {
    logger.info("PR is already merged!");
    throw new NeutralExitError();
  }

  if (pullRequest.head.repo.full_name !== pullRequest.base.repo.full_name) {
    logger.info("PR branch is from external repository, skipping");
    throw new NeutralExitError();
  }

  let action = null;
  for (const label of pullRequest.labels) {
    if (ACTIONS.includes(label.name)) {
      if (action === null) {
        action = label.name;
      } else {
        throw new Error(`ambiguous labels: ${action} + ${label.name}`);
      }
    }
  }

  if (action === null) {
    logger.info("No matching labels found on PR, skipping");
    throw new NeutralExitError();
  }

  if (!octokit || !dir || !url) {
    throw new Error("invalid arguments!");
  }

  if (action === "automerge") {
    await merge(dir, url, pullRequest);
  } else if (action === "autorebase") {
    const baseCommits = await listBaseCommits(octokit, pullRequest);
    await rebase(dir, url, pullRequest, baseCommits);
  } else {
    throw new Error(`invalid action: ${action}`);
  }
}

async function merge(dir, url, pullRequest) {
  const headRef = pullRequest.head.ref;
  const baseRef = pullRequest.base.ref;

  logger.debug("Cloning into", dir);
  await git.clone(url, dir, headRef, 1);
  await git.fetch(dir, baseRef);

  //await git.merge();
  // await git.rebase();
}

async function listBaseCommits(octokit, pullRequest) {
  logger.debug("Listing commits...");
  const { data: commits } = await octokit.pulls.listCommits({
    owner: pullRequest.head.repo.owner.login,
    repo: pullRequest.head.repo.name,
    number: pullRequest.number,
    per_page: 1
  });
  const tailCommit = commits[0];

  logger.trace("Tail commit:", tailCommit);

  logger.debug("Getting base commits...");
  const baseCommits = [];
  for (const parent of tailCommit.parents) {
    const { data: commit } = await octokit.git.getCommit({
      owner: pullRequest.head.repo.owner.login,
      repo: pullRequest.head.repo.name,
      commit_sha: parent.sha
    });
    baseCommits.push(commit);
  }

  logger.trace("Base commits:", baseCommits);

  return baseCommits;
}

async function rebase(dir, url, pullRequest, baseCommits) {
  logger.info(`Rebasing PR #${pullRequest.number} ${pullRequest.title}`);

  const headRef = pullRequest.head.ref;
  const baseRef = pullRequest.base.ref;

  logger.debug("Cloning into", dir, `(${headRef})`);
  await git.clone(url, dir, headRef, pullRequest.commits + 1);

  logger.debug("Fetching", baseRef, "...");
  const since = earliestDate(baseCommits);
  await git.fetchSince(dir, baseRef, since);

  const head = await git.head(dir);
  if (head !== pullRequest.head.sha) {
    logger.info(`HEAD changed to ${head}, skipping`);
    throw new NeutralExitError();
  }

  logger.info(headRef, "HEAD:", head, `(${pullRequest.commits} commits)`);

  const onto = await git.sha(dir, baseRef);

  if (baseCommits.length === 1 && baseCommits[0].sha === onto) {
    logger.info("Already up to date:", headRef, "->", baseRef, onto);
    throw new NeutralExitError();
  }

  logger.info("Rebasing onto", baseRef, onto);
  await git.rebase(dir, onto);

  logger.debug("Pushing changes...");
  await git.push(dir, true, headRef);
}

function earliestDate(commits) {
  let date = null;
  for (const commit of commits || []) {
    if (date === null || commit.committer.date < date) {
      date = commit.committer.date;
    }
  }
  return date;
}

module.exports = { update, earliestDate };