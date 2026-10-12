# GitLab

Back to the [README](../README.md).

A GitLab project can be a floor just like a GitHub repository: gitlab.com, or a company's own GitLab (one reached over a VPN works too). The office talks to it through the GitLab CLI, `glab`, the way it talks to GitHub through `gh`. A building can mix GitHub and GitLab floors.

## Set up

On the machine that runs the office:

```bash
brew install glab                       # or see https://gitlab.com/gitlab-org/cli#installation
glab auth login --hostname gitlab.example.com
```

Sign in with a personal access token that has the `api` and `write_repository` scopes, and the office lists every project that token is a member of in the elevator, on every GitLab `glab` is signed in to, next to your GitHub repositories. Or type the project yourself: `gitlab.example.com/group/subgroup/project`, its https or ssh URL, or the link to one of its merge requests. `gh` doesn't have to be installed for a building of GitLab floors, and the first-start walkthrough (`agent-office setup`) carries on with `glab` alone.

A GitLab project is cloned into the workspace folder as `<folder>/<host>/<group>/…/<project>`, over ssh unless `glab config set git_protocol https --host <host>` says otherwise. The clone uses the machine's own git credentials (its ssh key, or `glab`'s for https), so check that a plain `git clone` of the project works there first.

### A checkout you already have

Start the office in it, `agent-office ~/code/my-project`, or, with the office stopped, add it to `.agent-office/floors.json` in the office's home:

```json
[{ "id": "my-project", "dir": "/Users/me/code/my-project" }]
```

The office reads which GitLab project it is from the checkout's `origin` remote, so there's no need to say. Set `"repo": "gitlab.example.com/group/my-project"` only when `origin` points somewhere else.

## What a GitLab floor has

Everything a GitHub floor has, in GitLab's words: the boards, buttons and prompts say *merge request*, *MR* and `!12` instead of *pull request*, *PR* and `#12`, and the ☰ menu's board is **Merge requests**.

- **The issues board** shows the project's issues. Handing one to a worker assigns it to you on GitLab. GitLab has no close reason, so **Close issue… → not planned** adds a comment saying so.
- **The merge requests board** shows drafts, MRs in review, approved, merged and closed, with their pipeline's status and size. An MR's window has its description, comments, line threads, approvals, pipeline jobs and **Files changed**. **Merge…** squashes or makes a merge commit, as the project allows, and can leave it to merge when its pipeline passes. **Close MR…** can delete its branch.
- **Labels**, comments, the meeting room's reviews and the board agents work as they do on GitHub.
- **Opening an MR from a desk** (**O** at a worktree worker's desk) pushes the branch and opens a merge request with `glab`. A worker that opens one itself with `glab mr create` shows it at its desk, and `office-workers pr !12` (or the MR's URL) tells the office which one is its own.
- **Workers' prompts** use `glab` (`glab mr view`, `glab mr merge`…) instead of `gh`. Your own prompts in **⚙️ Settings → Prompts** are used on both kinds of floor.
- **Markdown** in descriptions and comments links `!12`, `#12` and `@someone` to that GitLab.

## Everyone's own GitLab

With [accounts](../README.md#add-users), **🔐 Your sign-ins** has a GitLab card once the building has a GitLab floor. Type the GitLab's address and paste a personal access token (GitLab: **Preferences → Access tokens**, with the `api` and `write_repository` scopes), and the office acts on GitLab as you: comments, merges, labels, claimed issues and merge requests show up under your name, and commits carry your GitLab name. Or type `glab auth login` in a 🐚 shell at a desk, which runs as you.

The token is kept by `glab` in your account's own folder, `.agent-office/homes/<account>/glab/`, never in the machine's keychain, which every account would share. Revoking the account deletes it. Admins can use the office machine's own `glab` instead. The boards are read with the machine's own `glab`, so its sign-in needs access to the projects.

Pushes go wherever the checkout's `origin` points. Over https they go out as you; over ssh they use the machine's ssh key, as they do on a GitHub floor.

## When something's wrong

- **"glab isn't signed in to this GitLab"**: run `glab auth login --hostname <host>` on the office's machine.
- **"The office can't reach this GitLab"**: check the network or VPN. The office runs `glab` with Go's own DNS resolver (`GODEBUG=netdns=go`), because on a Mac the system resolver times out when many lookups go over a VPN at once. Set `GODEBUG` yourself to override it.
- **A GitLab project is missing from the elevator**: the elevator lists projects you're a member of, not archived ones. Type its path instead.
- **An older GitLab**: fields its GraphQL doesn't have (approvals, reviewer states on Community Edition) are left out of the boards, not treated as errors.
