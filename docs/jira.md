# Jira

Back to the [README](../README.md).

A team that tracks its work in Jira Cloud rather than in GitHub or GitLab issues can put a Jira board on the walls instead. A Jira board isn't split by repository, so once it's set up **every floor's issues board is the same Jira board**: its own columns, its tickets on them, and the notes on the cork board are the tickets in its to-do column. The pull request (merge request) board is still each floor's own.

The office talks to Jira's REST API with an Atlassian account's email and an API token. Reading the board uses the office's own token, or a signed-in teammate's; moving, assigning and commenting go out as whoever does them.

## Set up

### 1. Make an API token

Sign in to Atlassian and open [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens). **Create API token**, give it a name like *Agent Office*, and copy it: Atlassian shows it once. The token acts as you, with your access, so it can see the boards and tickets you can. A token expires (a year at most); make a new one and paste it again when it does.

### 2. Point the office at the board

Open the board in Jira and copy its address from the browser, for example:

```
https://your-site.atlassian.net/jira/software/c/projects/CHAT/boards/143
```

An admin opens **⚙️ Settings → 🏢 Building → Jira board**, pastes the link and clicks **Use this board**, which turns it on. Any of the ways Jira writes a board's link works (`…/boards/143/backlog`, a team-managed `…/jira/software/projects/KEY/boards/1`, the old `…/secure/RapidBoard.jspa?rapidView=143`). Only Jira Cloud sites (`*.atlassian.net`) over https are taken, so the office never sends a token anywhere else. **Off** puts every floor back to its repository's issues.

### 3. The office's own token

In the same place, an admin can give the office an email and API token of its own (**Save token**). The office checks it with Jira (it says who it signs in as) before keeping it.

- **On the shared office password** (no accounts), this is the only Jira sign-in there is: the board is read with it, and everyone moves, assigns and comments as it. Use the token of whoever runs the office, or of a bot account.
- **With accounts**, it's optional: the office reads the board with it, and without it with the token of any teammate who has signed in to Jira. What people do to tickets still goes out as themselves.

### 4. Everyone's own sign-in (accounts)

With [accounts](../README.md#add-users), **☰ → 🔐 Your sign-ins** has a **📌 Jira** card once the board is on. Paste the email you sign in to Atlassian with and your own API token, and the card says *✅ your name*: moving, assigning and commenting on tickets go out as you, and a ticket your worker takes is assigned to you. Without it, those buttons say *Sign in to Jira first (☰ → 🔐 Your sign-ins)*. **Sign out** forgets it.

## Where the tokens are

Tokens stay on the office's machine. They're never sent to a browser (the windows only ever hear *who* a token is), never written to a log, and never put in a worker's environment: workers can't reach Jira, so everything a ticket says goes into their prompt.

- The office's own: `.agent-office/jira-office.json` in the office's home.
- Each account's own: `.agent-office/homes/<account>/jira.json`, which goes when the account is revoked.
- Which board, and whether it's on: `.agent-office/jira.json`.

Each is a file only the office's user can read (mode 0600).

## The board

**E** at the issues board on the wall (or **📌 Issues** in the **☰** menu, or the 2D view's **Issues**) opens the Jira board:

- **Its columns are the board's own**, from the board's configuration in Jira, with each ticket in the column its status is mapped to. A Kanban board's *Backlog* is left off, as Jira's own board leaves it off. A Scrum board shows its open sprint.
- **Finished tickets** are only the ones updated in the last two weeks, and at most the 40 newest, so the board isn't buried in them.
- **A card** shows the ticket's key (CHAT-123), its summary, its type (🐞 bug, 📗 story, ☑️ task…), its priority, its labels, who it's assigned to, where it is on the 📋 queue, and when it last changed.
- **Who:** the picker in the header shows *Everyone*, *Unassigned*, *Me* (once the office knows your Jira account), and then everyone with tickets on the board, each with how many they have. It's remembered in your browser.
- **Filter by key or title:** type to narrow every column to the tickets whose key or summary has every word you type.
- **🏊 By assignee** splits the board into a row of columns for each person (the unassigned tickets last). It's remembered too.
- **🔄 Refresh** looks at Jira again. The office looks every 90 seconds or so while anyone's in, and straight after anything is done to a ticket from the office.

**The cork board on the wall** holds the tickets in the board's to-do column (the first column called something like *To Do*, *Selected for Development* or *Ready*, else the first), by key. Point at a note and press **E** to take its card, or **O** to read it.

## A ticket's window

Click a card (or **O** at its note) to open its window, with its key, summary, type, status, priority, assignee, reporter, labels and parent, its description and its comments (Jira's formatting comes through as Markdown: headings, lists, code, links, tables, mentions and the like), and **Open in Jira ↗**.

- **Status:** pick where to move it (the moves Jira offers you from where it is) and **Move**.
- **Assignee:** **🙋 Assign to me**, or type a teammate's name to find them and click them, or **Unassign**.
- **Comment:** type a comment and **💬 Comment** (or ⌘/Ctrl+Enter). It goes to Jira as plain text, a paragraph for each block of lines.
- **🤖 Hand to a worker**, **📋 Add to queue**, **✋ Pick it up**, **✍️ Ask a worker…** and **🤝 Meeting…** work as they do for an issue: a carried card can go to an empty desk, a worker, the queue, the herald or the meeting room.

**✕** or **Esc** closes it.

### When a worker takes a ticket

However a worker gets a ticket (handed over, its card dropped at a desk, or the queue seating one for it), it's *in progress* on the board at once and its note comes off the wall. Then the office moves it in Jira to the first column after the to-do one that Jira lets it move to from where it is (*In Progress*, usually), and assigns it to whoever took it when they're signed in to Jira (on the shared password, to the office's account). If Jira won't do either, you're told why, and the worker keeps the ticket.

The worker's prompt is **⚙️ Settings → Workers → Prompts → 🤖 Hand a Jira ticket to a worker**: the ticket's key, type, summary and link, and its description as text, since the worker can't read Jira itself. It asks for a branch and a pull request with the key in them, so Jira's development panel links them. **✍️ Ask a worker about a Jira ticket** and **🤝 Meeting about a Jira ticket** are there too. Rewrite them like any of the office's prompts; your other prompts are unchanged.

## When something's wrong

- **"Jira didn't accept the email and API token: the token is wrong or has expired"**: make a new token and paste it again (⚙️ Settings for the office's, 🔐 Your sign-ins for your own). Check the email is the one you sign in to Atlassian with.
- **"That Jira account has no access to board 143"** or **"Jira can't find board 143, or that account can't see it"**: check the board link, and that the account whose token reads the board (the office's, or else a teammate's) can open the board in Jira. A board's filter can hide tickets from projects the account can't browse.
- **"The office has no Jira API token to read the board with"**: an admin adds the office's token in ⚙️ Settings, or someone signs in to Jira in 🔐 Your sign-ins.
- **"Sign in to Jira first (☰ → 🔐 Your sign-ins)"**: with accounts, moving, assigning and commenting go out as you, so you need your own Jira sign-in.
- **"Jira has no way to move it to In Progress from where it is"**: the board's workflow has no transition from the ticket's status to any column after the to-do one, for that account. Move it yourself from its window or in Jira.
- **A ticket is missing**: its status isn't mapped to a column on the board (Jira's board leaves it off too), it's finished and older than two weeks, or (on a Scrum board) it isn't in the open sprint.
- **"Couldn't reach Jira at your-site.atlassian.net"**: the office's machine can't get to Jira (network, proxy or VPN), or Jira took longer than 20 seconds to answer.
