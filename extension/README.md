# code-gty: Ghostty Terminal

A terminal that opens as an editor tab and uses [Ghostty](https://ghostty.org)'s terminal emulation (through [ghostty-web](https://github.com/coder/ghostty-web)). Because each terminal is an editor tab, you can drag it, split it, dock it next to code or pop it out into its own window.

It runs on desktop VS Code, Remote SSH, WSL, Dev Containers, Codespaces, and server-hosted editors such as code-server and Coder. It does not run in vscode.dev or github.dev without a remote, because those cannot start a shell.

## Getting started

- **Ghostty: New Terminal** (`Ctrl+Alt+\``) opens a terminal in the current editor group.
- **Ghostty: New Terminal to the Side** opens one beside it, in the same directory.
- Drag the tab anywhere, or right-click it and choose **Move into New Window**.

The terminal follows your `terminal.integrated.*` settings: default profile, font size, cursor, scrollback, environment, copy on selection, right-click behaviour, bell, `confirmOnKill` and so on. It also uses your colour theme's terminal colours.

## Keyboard

Most keys go to the shell. A pass-through list sends workbench shortcuts to VS Code instead: Quick Open, the Command Palette, panel and sidebar toggles, and switching tabs. With `terminal.integrated.sendKeybindingsToShell` on, almost every key goes to the shell.

VS Code does not let extensions read your keybindings, so if you have custom shortcuts that should work while the terminal has focus, add them to `codeGty.passThroughKeys` (for example `"ctrl+shift+o"`). For keys the shell should always get, such as `ctrl+b` for tmux, use `codeGty.shellKeys`.

| Action | Linux and Windows | macOS |
| --- | --- | --- |
| Copy | `Ctrl+Shift+C` (Windows: also `Ctrl+C` with a selection) | `Cmd+C` |
| Paste | `Ctrl+Shift+V`, `Shift+Insert` (Windows: also `Ctrl+V`) | `Cmd+V` |
| Find | `Ctrl+F` | `Cmd+F` |
| Previous or next command | `Ctrl+Up`, `Ctrl+Down` | `Cmd+Up`, `Cmd+Down` |
| Clear | Command Palette | `Cmd+K` |

## Shell integration

For bash, zsh, fish and PowerShell, code-gty loads a small script through the shell's normal startup files. The script reports prompts, commands, exit codes and the current directory. That information powers "scroll to previous/next command", new terminals in the same directory, file links relative to the right directory, and restoring tabs after a reload. Turn it off with `terminal.integrated.shellIntegration.enabled`.

## Links

Ctrl+click (Cmd+click on macOS) opens:

- web links, through VS Code, so `localhost` links are forwarded when you work remotely;
- file paths such as `src/main.rs:10:5`, at the given line and column.
- OSC 8 hyperlinks (text that a program marks as a link, as `ls --hyperlink`, `gcc` and `systemctl` do), to the URL or file they point at.

## Settings

| Setting | Purpose |
| --- | --- |
| `codeGty.passThroughKeys` | Extra keys that go to the workbench instead of the shell |
| `codeGty.shellKeys` | Keys that always go to the shell |
| `codeGty.env` | Extra environment variables (`null` removes one) |
| `codeGty.fontFamily` | Terminal font (default: bundled IosevkaTerm Nerd Font Mono; `null` follows `terminal.integrated.fontFamily`) |
| `codeGty.fontSize` | Override the terminal font size for this extension only |
| `codeGty.colors` | Override individual theme colours |
| `codeGty.osc52` | Whether programs may set (`write`) or also read (`readWrite`) the clipboard |
| `codeGty.term` | Value of `TERM` (default `xterm-256color`) |
| `codeGty.retainContextWhenHidden` | Keep background tabs alive in memory (default on) |
| `codeGty.flowControlWindow`, `codeGty.replayBufferSize` | Output tuning |

### Fonts

The extension bundles the complete **IosevkaTerm Nerd Font Mono** (regular, bold, italic, bold italic), the default, so it works the same in VS Code, VSCodium and code-server (including in the browser) without installing anything. Every glyph is included, the Nerd Font icons too, and each icon is sized to one cell. The glyphs are exactly half an em wide, so at even font sizes the cells line up on whole pixels with no extra spacing.

Powerline separators (U+E0B0–E0BF, including the rounded arches) and block elements (U+2580–259F) are drawn as shapes that exactly fill their cell, as native Ghostty and VS Code's own terminal do, so they line up with neighbouring cell backgrounds at any font, size or display scale.

Set `"codeGty.fontFamily": null` to use `terminal.integrated.fontFamily` instead, or name any other font. For Nerd Font icons with another font, use its *Nerd Font Mono* build: the canvas renderer draws each glyph at the font's own size, so icons only fit their cell when they come from the same font as the text.

Fonts installed on your machine also work in desktop VS Code and VSCodium. In code-server, only fonts on the machine running the browser can be used.

### Built-in settings that are not supported yet

- `terminal.integrated.lineHeight`, `letterSpacing`, `fontWeight`, `fontWeightBold`, `minimumContrastRatio` and `wordSeparators`: ghostty-web 0.4 has no options for these.
- `terminal.integrated.rightClickBehavior: "selectWord"` shows the context menu instead.
- Middle-click paste and the Linux primary selection.

## Known limitations

This terminal is a webview, not a VS Code terminal, so:

- it does not appear in the terminal panel's list or in `window.terminals`, and the Tasks system and debugger cannot use it;
- other extensions' terminal link providers, quick fixes and environment contributions (for example the git extension's askpass helper) do not apply. Extensions can use this extension's own API instead (below);
- **Terminal: Run Selected Text** targets the built-in terminal. Use **Ghostty: Run Selected Text in Active Ghostty Terminal** (`Ctrl+Alt+Enter`) instead;
- in a browser (code-server, Coder), keys the browser keeps for itself, such as `Ctrl+W`, cannot be captured;
- a window reload restarts the shell, in the same directory, with a divider line. Sessions that survive a reload are planned. In browser-hosted editors the directory is saved lazily, so a `cd` made in the last few seconds before a reload can be lost;
- browser-hosted editors must be served over HTTPS or from `localhost`. Over plain HTTP from another host, VS Code disables all webviews, including this terminal;
- screen-reader support is basic: a live region of the visible screen when `editor.accessibilitySupport` is `on`, and **Ghostty: Show Recent Output (Accessible)**.

## API for other extensions

```ts
const api = vscode.extensions.getExtension('code-gty.code-gty')?.exports;
const term = api.createTerminal({ name: 'build', cwd: '/work', env: { CI: '1' } });
term.sendText('make');
const off = api.contributeEnvironment('my-extension', { MY_TOOL_SOCKET: '/tmp/s' });
```

The commands `codeGty.sendText` (`{ text, addNewLine }`) and `codeGty.new` can also be called with `vscode.commands.executeCommand`.

## Privacy

code-gty collects no telemetry.
