# Release checklist (real machines)

Docker cannot run Windows or macOS, Remote SSH or WSL, so run this list by hand on each before a release. Install the platform's VSIX from `dist/` and verify `dist/SHA256SUMS` first.

Environments: Windows x64, Windows arm64, macOS arm64, macOS x64, Remote SSH (Linux host), WSL 2, Dev Container.

## Every environment

- [ ] **Ghostty: New Terminal** opens a tab with a working prompt in the workspace folder.
- [ ] `vim`, `less` and `htop` (or `btop`, or `top` on macOS) draw correctly and resize with the tab.
- [ ] `cat` of a 50 MB file finishes, and the window stays responsive while it runs.
- [ ] The tab drags into a split, into another group, and into a new window, and keeps working in each.
- [ ] Copy and paste work both ways with the system clipboard, including a multi-line paste (with a warning when the shell lacks bracketed paste).
- [ ] Ctrl+click (Cmd+click) on `https://example.com` opens the browser. On a `localhost:PORT` link from a remote, it opens through port forwarding.
- [ ] Ctrl+click on `src/file.ts:10:5` printed by a tool opens the file at that position.
- [ ] Ctrl+P, the Command Palette, Ctrl+\` and tab switching reach the workbench; Ctrl+C, Ctrl+R and Ctrl+D reach the shell.
- [ ] Switching the colour theme recolours the terminal and keeps its content.
- [ ] After `cd /tmp`, **New Terminal to the Side** starts in `/tmp`. Ctrl+Up and Ctrl+Down jump between prompts.
- [ ] Reload the window: the tab returns with a "Session restarted" divider in the same directory.
- [ ] Close a tab while `sleep 100` is running: a confirmation appears, and **Keep Running** brings the tab back with the session intact.
- [ ] `exit` closes the tab; `exit 3` leaves it open with the exit message.
- [ ] `echo $TERM_PROGRAM` prints `vscode`, and `code somefile` opens in the **current** window.
- [ ] With the workspace in Restricted Mode, no terminal can be opened.
- [ ] The **code-gty** output channel shows no errors.

## Per platform

- [ ] **macOS:** the shell is a login shell (`shopt login_shell` or `[[ -o login ]]`). Cmd+K clears the screen. `terminal.integrated.macOptionIsMeta` makes Option+B move back a word.
- [ ] **Windows:** PowerShell is the default and has shell integration (cwd is tracked). Command Prompt and Git Bash profiles start. Ctrl+V pastes, and Ctrl+C copies when there is a selection.
- [ ] **Remote SSH and WSL:** the extension runs on the remote side (Extensions view: "Install in SSH: ..."), and the shell is the remote's.
- [ ] **Dev Container (Alpine base image):** the alpine VSIX installs and the shell starts.
